import type { Hono } from "hono";
import { validateAndSanitizeUrl } from "./oauth-utils";
import { PUBLIC_ROUTES, PUBLIC_ROUTE_PREFIXES } from "./routes";
import type {
	AuthHooks,
	BaseProps,
	BearerAuthRouteGroup,
} from "./types";

export interface BearerMCPServer {
	// biome-ignore lint/suspicious/noExplicitAny: McpAgent serve fetch signature is loose
	serve(path: string, options?: unknown): { fetch: (req: any, env: any, ctx: any) => Promise<Response> };
	// biome-ignore lint/suspicious/noExplicitAny: McpAgent serveSSE fetch signature is loose
	serveSSE(path: string, options?: unknown): { fetch: (req: any, env: any, ctx: any) => Promise<Response> };
}

export interface WithBearerHandlerOptions<P extends BaseProps = BaseProps> {
	hooks?: AuthHooks<P>;
	/**
	 * Path prefix overrides. By default `/bearer/*` and `/token/*` mount.
	 * Override e.g. to `/auth/bearer` + `/auth/token` for multi-mode servers.
	 */
	prefixes?: {
		bearer?: string;
		token?: string;
	};
	/**
	 * Inner-route paths (relative to the prefix). Default `/mcp` and `/sse`.
	 */
	innerRoutes?: {
		mcp?: string;
		sse?: string;
	};
}

type AuthRouteFamily = "bearer" | "token";

function getAuthMetricRouteGroup(
	pathname: string,
	authRouteFamily: AuthRouteFamily,
	ssePath: string,
): BearerAuthRouteGroup {
	if (pathname.endsWith(ssePath)) {
		return authRouteFamily === "bearer" ? "bearer_sse" : "token_sse";
	}
	return authRouteFamily === "bearer" ? "bearer_mcp" : "token_mcp";
}

function recordBearerMetric<P extends BaseProps>(
	hooks: AuthHooks<P> | undefined,
	status: number,
	ctx: ExecutionContext,
	req: Request,
	group: BearerAuthRouteGroup,
): void {
	if (!hooks?.onBearerMetric) return;
	try {
		hooks.onBearerMetric(status, ctx, req, group);
	} catch (err) {
		console.error("onBearerMetric hook failed:", err);
	}
}

async function handleTokenAuth<P extends BaseProps>(
	req: Request,
	env: unknown,
	ctx: ExecutionContext,
	MCPServer: BearerMCPServer,
	authRouteFamily: AuthRouteFamily,
	hooks: AuthHooks<P> | undefined,
	mcpPath: string,
	ssePath: string,
): Promise<Response> {
	const url = new URL(req.url);
	const authMetricRouteGroup = getAuthMetricRouteGroup(
		url.pathname,
		authRouteFamily,
		ssePath,
	);

	try {
		const authHeader = req.headers.get("authorization");
		if (!authHeader) {
			const response = new Response("Bearer token is required", { status: 400 });
			recordBearerMetric(hooks, response.status, ctx, req, authMetricRouteGroup);
			return response;
		}

		let accessToken = authHeader.split(" ")[1];
		let tsHost: string | null;

		if (accessToken?.includes("@")) {
			[accessToken, tsHost] = accessToken.split("@");
		} else {
			tsHost = req.headers.get("x-ts-host");
		}

		if (!tsHost) {
			const response = new Response(
				"TS Host is required, either in the authorization header as 'token@ts-host' or as a separate 'x-ts-host' header",
				{ status: 400 },
			);
			recordBearerMetric(hooks, response.status, ctx, req, authMetricRouteGroup);
			return response;
		}

		const clientName =
			req.headers.get("x-ts-client-name") || "Bearer Token client";

		const baseProps: BaseProps = {
			accessToken: accessToken!,
			instanceUrl: validateAndSanitizeUrl(tsHost),
			clientName: {
				clientId: clientName,
				clientName,
				registrationDate: Date.now(),
			},
		};

		const props = hooks?.extendProps
			? hooks.extendProps(req, baseProps)
			: (baseProps as P);

		(ctx as unknown as { props: P }).props = props;

		let response: Response;
		const pathname = url.pathname;
		if (pathname.endsWith(mcpPath)) {
			response = await MCPServer.serve(mcpPath).fetch(req, env, ctx);
		} else if (pathname.endsWith(ssePath)) {
			response = await MCPServer.serveSSE(ssePath).fetch(req, env, ctx);
		} else {
			response = new Response("Not found", { status: 404 });
		}

		recordBearerMetric(hooks, response.status, ctx, req, authMetricRouteGroup);
		return response;
	} catch (error) {
		recordBearerMetric(hooks, 500, ctx, req, authMetricRouteGroup);
		throw error;
	}
}

export function withBearerHandler<
	P extends BaseProps = BaseProps,
	// biome-ignore lint/suspicious/noExplicitAny: Hono env is consumer-defined
	HonoEnv extends { Bindings: any } = { Bindings: any },
>(
	app: Hono<HonoEnv>,
	MCPServer: BearerMCPServer,
	options: WithBearerHandlerOptions<P> = {},
): Hono<HonoEnv> {
	const bearerPrefix = options.prefixes?.bearer ?? PUBLIC_ROUTE_PREFIXES.bearer;
	const tokenPrefix = options.prefixes?.token ?? PUBLIC_ROUTE_PREFIXES.token;
	const mcpPath = options.innerRoutes?.mcp ?? PUBLIC_ROUTES.mcp;
	const ssePath = options.innerRoutes?.sse ?? PUBLIC_ROUTES.sse;

	app.mount(bearerPrefix, (req, env, ctx) =>
		handleTokenAuth(
			req,
			env,
			ctx,
			MCPServer,
			"bearer",
			options.hooks,
			mcpPath,
			ssePath,
		),
	);

	app.mount(tokenPrefix, (req, env, ctx) =>
		handleTokenAuth(
			req,
			env,
			ctx,
			MCPServer,
			"token",
			options.hooks,
			mcpPath,
			ssePath,
		),
	);

	return app;
}
