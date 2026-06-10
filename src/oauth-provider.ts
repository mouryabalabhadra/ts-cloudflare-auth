import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { type AuthAppEnv, createAuthApp } from "./handlers";
import { withBearerHandler } from "./bearer";
import { PUBLIC_ROUTES } from "./routes";
import type {
	AssetsFetcher,
	AuthHooks,
	BaseProps,
	ServerInfo,
} from "./types";

export interface MCPServerForOAuth {
	// biome-ignore lint/suspicious/noExplicitAny: McpAgent serve fetch signature is loose
	serve(path: string, options?: unknown): { fetch: (req: any, env: any, ctx: any) => Promise<Response> };
	// biome-ignore lint/suspicious/noExplicitAny: McpAgent serveSSE fetch signature is loose
	serveSSE(path: string, options?: unknown): { fetch: (req: any, env: any, ctx: any) => Promise<Response> };
}

export interface CreateOAuthHandlerOptions<P extends BaseProps = BaseProps> {
	serverInfo: ServerInfo;
	mcpServerClass: MCPServerForOAuth;
	/**
	 * Override the MCP/SSE paths handled by the OAuth provider.
	 * Default: { mcp: "/mcp", sse: "/sse" }.
	 * spotter-code mixed-mode usage: { mcp: "/auth/mcp", sse: "/auth/sse" }.
	 */
	routes?: {
		mcp?: string;
		sse?: string;
		authorize?: string;
		oauthToken?: string;
		register?: string;
	};
	hooks?: AuthHooks<P>;
	assetsFetcher?: AssetsFetcher;
	/**
	 * Hook to wrap the inner MCP fetch (e.g. apply per-request prop injection
	 * outside the bearer flow). Receives the request + injects props.
	 */
	enrichMcpRequestProps?: (
		req: Request,
		ctx: ExecutionContext,
		baseProps: BaseProps,
	) => P;
	/**
	 * Mount extra Hono routes onto the default handler (e.g. `/hello`, well-known files).
	 * Runs after auth routes are registered.
	 */
	extraRoutes?: Parameters<typeof createAuthApp>[0]["extraRoutes"];
}

/**
 * Builds a Cloudflare Worker fetch handler that wraps an MCP DO with
 * OAuth 2.0 + bearer/token authentication.
 *
 * Returns the OAuthProvider's `fetch` directly (consumers wrap with their own
 * tracing/metrics/middleware).
 */
export function createOAuthHandler<P extends BaseProps = BaseProps>(
	options: CreateOAuthHandlerOptions<P>,
): { fetch: ExportedHandlerFetchHandler } {
	const mcpPath = options.routes?.mcp ?? PUBLIC_ROUTES.mcp;
	const ssePath = options.routes?.sse ?? PUBLIC_ROUTES.sse;
	const authorizeEndpoint = options.routes?.authorize ?? PUBLIC_ROUTES.authorize;
	const tokenEndpoint = options.routes?.oauthToken ?? PUBLIC_ROUTES.oauthToken;
	const registerEndpoint = options.routes?.register ?? PUBLIC_ROUTES.register;

	const honoApp = createAuthApp({
		serverInfo: options.serverInfo,
		hooks: options.hooks as AuthHooks<BaseProps> | undefined,
		assetsFetcher: options.assetsFetcher,
		extraRoutes: options.extraRoutes,
	});

	withBearerHandler<P, AuthAppEnv>(honoApp, options.mcpServerClass, {
		hooks: options.hooks,
	});

	// Builds the per-route MCP serve router with optional props enrichment.
	function buildMcpRouter(path: string, method: "serve" | "serveSSE") {
		return {
			async fetch(
				request: Request,
				env: unknown,
				ctx: ExecutionContext,
			): Promise<Response> {
				if (options.enrichMcpRequestProps) {
					const originalProps =
						(ctx as unknown as { props?: BaseProps }).props ?? ({} as BaseProps);
					(ctx as unknown as { props: P }).props =
						options.enrichMcpRequestProps(request, ctx, originalProps);
				}
				return options.mcpServerClass[method](path).fetch(request, env, ctx);
			},
		};
	}

	const oauthProvider = new OAuthProvider({
		apiHandlers: {
			[mcpPath]: buildMcpRouter(mcpPath, "serve") as never,
			[ssePath]: buildMcpRouter(ssePath, "serveSSE") as never,
		},
		// biome-ignore lint/suspicious/noExplicitAny: OAuthProvider types are loose
		defaultHandler: honoApp as any,
		authorizeEndpoint,
		tokenEndpoint,
		clientRegistrationEndpoint: registerEndpoint,
	});

	return {
		fetch: ((request: Request, env: unknown, ctx: ExecutionContext) =>
			oauthProvider.fetch(
				request,
				env as never,
				ctx,
			)) as unknown as ExportedHandlerFetchHandler,
	};
}
