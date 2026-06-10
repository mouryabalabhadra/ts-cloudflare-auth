import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import { decodeBase64Url, encodeBase64Url } from "hono/utils/encode";
import { McpServerError } from "./errors";
import {
	buildSamlRedirectUrl,
	parseRedirectApproval,
	renderApprovalDialog,
} from "./oauth-utils";
import { renderTokenCallback } from "./token-utils";
import { PUBLIC_ROUTES } from "./routes";
import type {
	AssetsFetcher,
	AuthHooks,
	AuthMetricName,
	BaseProps,
	ServerInfo,
} from "./types";

export interface AuthAppEnv {
	Bindings: { OAUTH_PROVIDER: OAuthHelpers; ASSETS?: AssetsFetcher } & Record<
		string,
		unknown
	>;
}

export interface CreateAuthAppOptions {
	serverInfo: ServerInfo;
	hooks?: AuthHooks<BaseProps>;
	/**
	 * Custom assets fetcher. If omitted, the auth app will use `c.env.ASSETS`.
	 */
	assetsFetcher?: AssetsFetcher;
	/**
	 * Add extra routes to the Hono app after the auth routes are registered.
	 * Useful for consumer-specific endpoints (e.g. /hello, well-known files).
	 */
	extraRoutes?: (app: Hono<AuthAppEnv>) => void;
}

function recordAuthMetric(
	hooks: AuthHooks<BaseProps> | undefined,
	name: AuthMetricName,
	status: number,
	c: { executionCtx: ExecutionContext; req: { raw: Request } },
): void {
	if (!hooks?.onAuthMetric) return;
	try {
		hooks.onAuthMetric(name, status, c.executionCtx, c.req.raw);
	} catch (err) {
		console.error("onAuthMetric hook failed:", err);
	}
}

async function wrap<T>(
	hooks: AuthHooks<BaseProps> | undefined,
	name: string,
	fn: () => Promise<T>,
): Promise<T> {
	if (hooks?.wrapSpan) return hooks.wrapSpan(name, fn);
	return fn();
}

export function createAuthApp(
	options: CreateAuthAppOptions,
): Hono<AuthAppEnv> {
	const { serverInfo, hooks, assetsFetcher, extraRoutes } = options;
	const app = new Hono<AuthAppEnv>();

	const handler = {
		async getAuthorize(request: Request, oauthProvider: OAuthHelpers) {
			const oauthReqInfo = await oauthProvider.parseAuthRequest(request);
			const { clientId } = oauthReqInfo;

			if (!clientId) {
				throw new McpServerError({ message: "Missing client ID" }, 400);
			}
			if (!oauthReqInfo.codeChallenge) {
				throw new McpServerError(
					{ message: "PKCE is required: missing code challenge" },
					400,
				);
			}
			if (oauthReqInfo.codeChallengeMethod !== "S256") {
				throw new McpServerError(
					{ message: "PKCE code challenge method must be S256" },
					400,
				);
			}
			const client = await oauthProvider.lookupClient(clientId);
			return renderApprovalDialog(request, {
				client,
				serverInfo,
				state: { oauthReqInfo },
			});
		},

		async postAuthorize(request: Request, requestUrl: string) {
			try {
				const { state, instanceUrl } = await parseRedirectApproval(request);

				if (!state.oauthReqInfo) {
					throw new McpServerError(
						{ message: "Missing OAuth request info" },
						400,
					);
				}

				if (!instanceUrl) {
					throw new McpServerError({ message: "Missing instance URL" }, 400);
				}

				const origin = new URL(requestUrl).origin;

				// Free-trial shortcut: skip SAML, assume logged in.
				if (
					instanceUrl.match(/^https:\/\/(?:team|my)\d+\.thoughtspot\.cloud\/?$/)
				) {
					const callbackUrl = new URL("/callback", origin);
					callbackUrl.searchParams.set("instanceUrl", instanceUrl);
					callbackUrl.searchParams.set(
						"oauthReqInfo",
						encodeBase64Url(
							new TextEncoder().encode(JSON.stringify(state.oauthReqInfo))
								.buffer as ArrayBuffer,
						),
					);
					return callbackUrl.toString();
				}

				return buildSamlRedirectUrl(instanceUrl, state.oauthReqInfo, origin);
			} catch (error) {
				if (error instanceof McpServerError) throw error;
				throw new McpServerError(error, 500);
			}
		},

		async handleCallback(
			request: Request,
			assets: AssetsFetcher,
			requestUrl: string,
		) {
			const url = new URL(request.url);
			const instanceUrl = url.searchParams.get("instanceUrl");
			const encodedOauthReqInfo = url.searchParams
				.get("oauthReqInfo")
				// Workaround for https://thoughtspot.atlassian.net/browse/SCAL-258056
				?.replace("/10023.html", "");

			if (!instanceUrl) {
				throw new McpServerError({ message: "Missing instance URL" }, 400);
			}
			if (!encodedOauthReqInfo) {
				throw new McpServerError({ message: "Missing OAuth request info" }, 400);
			}

			let decodedOAuthReqInfo: unknown;
			try {
				decodedOAuthReqInfo = JSON.parse(
					new TextDecoder().decode(decodeBase64Url(encodedOauthReqInfo)),
				);
			} catch (error) {
				throw new McpServerError(
					{ message: "Invalid OAuth request info format", details: error },
					400,
				);
			}
			const origin = new URL(requestUrl).origin;
			try {
				return await renderTokenCallback(
					instanceUrl,
					decodedOAuthReqInfo,
					assets,
					origin,
				);
			} catch (error) {
				throw new McpServerError(
					{ message: "Error rendering token callback", details: error },
					500,
				);
			}
		},

		async storeToken(request: Request, oauthProvider: OAuthHelpers) {
			// biome-ignore lint/suspicious/noExplicitAny: payload shape is consumer-defined
			let token: any;
			// biome-ignore lint/suspicious/noExplicitAny: AuthRequest from oauth provider
			let oauthReqInfo: any;
			let instanceUrl: string | undefined;

			try {
				// biome-ignore lint/suspicious/noExplicitAny: free-form body
				const body = (await request.json()) as any;
				token = body.token;
				oauthReqInfo = body.oauthReqInfo;
				instanceUrl = body.instanceUrl;
			} catch (error) {
				throw new McpServerError(
					{ message: "Invalid JSON format", details: error },
					400,
				);
			}

			if (!token || !oauthReqInfo || !instanceUrl) {
				throw new McpServerError(
					{ message: "Missing token or OAuth request info or instanceUrl" },
					400,
				);
			}

			const { clientId } = oauthReqInfo;
			if (!clientId) {
				throw new McpServerError({ message: "Missing clientId" }, 400);
			}
			const clientName = await oauthProvider.lookupClient(clientId);

			const props: BaseProps = {
				accessToken: token.data.token,
				instanceUrl: instanceUrl,
				clientName: clientName,
			};

			const { redirectTo } = await oauthProvider.completeAuthorization({
				request: oauthReqInfo,
				userId: "default",
				metadata: { label: "default" },
				scope: oauthReqInfo.scope,
				props,
			});

			return { redirectTo };
		},
	};

	app.get(PUBLIC_ROUTES.authorize, async (c) => {
		try {
			const response = await wrap(hooks, "authorize-get", () =>
				handler.getAuthorize(c.req.raw, c.env.OAUTH_PROVIDER),
			);
			recordAuthMetric(
				hooks,
				"oauth_authorize_requests_total",
				response.status,
				c,
			);
			return response;
		} catch (error) {
			const response = c.text(`Internal Server Error ${error}`, 500);
			recordAuthMetric(
				hooks,
				"oauth_authorize_requests_total",
				response.status,
				c,
			);
			return response;
		}
	});

	app.post(PUBLIC_ROUTES.authorize, async (c) => {
		try {
			const redirectUrl = await wrap(hooks, "authorize-post", () =>
				handler.postAuthorize(c.req.raw, c.req.url),
			);
			const response = Response.redirect(redirectUrl);
			recordAuthMetric(
				hooks,
				"oauth_authorize_submit_total",
				response.status,
				c,
			);
			return response;
		} catch (error) {
			if (
				error instanceof Error &&
				error.message.includes("Missing instance URL")
			) {
				const response = new Response("Missing instance URL", { status: 400 });
				recordAuthMetric(
					hooks,
					"oauth_authorize_submit_total",
					response.status,
					c,
				);
				return response;
			}
			const response = new Response(`Internal Server Error ${error}`, {
				status: 500,
			});
			recordAuthMetric(
				hooks,
				"oauth_authorize_submit_total",
				response.status,
				c,
			);
			return response;
		}
	});

	app.get(PUBLIC_ROUTES.callback, async (c) => {
		const assets = assetsFetcher ?? c.env.ASSETS;
		if (!assets) {
			const response = c.text(
				"ASSETS binding required for OAuth callback rendering",
				500,
			);
			recordAuthMetric(hooks, "oauth_callback_total", response.status, c);
			return response;
		}
		try {
			const htmlContent = await wrap(hooks, "oauth-callback", () =>
				handler.handleCallback(c.req.raw, assets, c.req.url),
			);
			const response = new Response(htmlContent, {
				headers: { "Content-Type": "text/html" },
			});
			recordAuthMetric(hooks, "oauth_callback_total", response.status, c);
			return response;
		} catch (error) {
			if (error instanceof Error) {
				if (error.message.includes("Missing instance URL")) {
					const response = c.text(`Missing instance URL ${error}`, 400);
					recordAuthMetric(hooks, "oauth_callback_total", response.status, c);
					return response;
				}
				if (error.message.includes("Missing OAuth request info")) {
					const response = c.text(`Missing OAuth request info ${error}`, 400);
					recordAuthMetric(hooks, "oauth_callback_total", response.status, c);
					return response;
				}
				if (error.message.includes("Invalid OAuth request info format")) {
					const response = c.text(
						`Invalid OAuth request info format ${error}`,
						400,
					);
					recordAuthMetric(hooks, "oauth_callback_total", response.status, c);
					return response;
				}
			}
			const response = c.text(`Internal server error ${error}`, 500);
			recordAuthMetric(hooks, "oauth_callback_total", response.status, c);
			return response;
		}
	});

	app.post(PUBLIC_ROUTES.storeToken, async (c) => {
		try {
			const result = await wrap(hooks, "store-token", () =>
				handler.storeToken(c.req.raw, c.env.OAUTH_PROVIDER),
			);
			const response = new Response(JSON.stringify(result), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
			recordAuthMetric(hooks, "oauth_store_token_total", response.status, c);
			return response;
		} catch (error) {
			if (error instanceof Error) {
				if (error.message.includes("Invalid JSON format")) {
					const response = c.text(`Invalid JSON format ${error}`, 400);
					recordAuthMetric(
						hooks,
						"oauth_store_token_total",
						response.status,
						c,
					);
					return response;
				}
				if (
					error.message.includes(
						"Missing token or OAuth request info or instanceUrl",
					)
				) {
					const response = c.text(
						`Missing token or OAuth request info or instanceUrl ${error}`,
						400,
					);
					recordAuthMetric(
						hooks,
						"oauth_store_token_total",
						response.status,
						c,
					);
					return response;
				}
			}
			const response = c.text(`Internal server error ${error}`, 500);
			recordAuthMetric(hooks, "oauth_store_token_total", response.status, c);
			return response;
		}
	});

	if (extraRoutes) {
		extraRoutes(app);
	}

	return app;
}
