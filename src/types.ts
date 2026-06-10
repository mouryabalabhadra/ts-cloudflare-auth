import type { ClientInfo } from "@cloudflare/workers-oauth-provider";

/**
 * Minimum props injected into the MCP server context after successful auth.
 * Consumers can extend via `extendProps` hook.
 */
export interface BaseProps {
	accessToken: string;
	instanceUrl: string;
	clientName:
		| ClientInfo
		| {
				clientId: string;
				clientName: string;
				registrationDate: number;
		  }
		| null;
}

/**
 * Branding for approval dialog + token callback pages.
 */
export interface ServerInfo {
	name: string;
	logo?: string;
	description?: string;
	/** Logo for the approval dialog (left side). Defaults to MCP logo. */
	mcpLogoUrl?: string;
	/** Logo for the right side (target service). Defaults to ThoughtSpot logo. */
	instanceLogoUrl?: string;
	termsUrl?: string;
	privacyUrl?: string;
	signupUrl?: string;
	/** Approval dialog title. Defaults to "<name> wants access to your ThoughtSpot instance". */
	approvalTitle?: string;
}

export type AuthMetricName =
	| "oauth_authorize_requests_total"
	| "oauth_authorize_submit_total"
	| "oauth_callback_total"
	| "oauth_store_token_total";

export type BearerAuthRouteGroup =
	| "bearer_mcp"
	| "bearer_sse"
	| "token_mcp"
	| "token_sse";

export interface AuthHooks<P extends BaseProps = BaseProps> {
	/** Called on each OAuth flow request with the response status. Use to record metrics. */
	onAuthMetric?: (
		name: AuthMetricName,
		status: number,
		ctx: ExecutionContext,
		req: Request,
	) => void;
	/** Called on each bearer/token MCP request. */
	onBearerMetric?: (
		status: number,
		ctx: ExecutionContext,
		req: Request,
		group: BearerAuthRouteGroup,
	) => void;
	/**
	 * Extend the props object set onto the execution context before MCP handler runs.
	 * Use to stamp custom fields (e.g. api version) from request headers/query params.
	 */
	extendProps?: (req: Request, base: BaseProps) => P;
	/**
	 * Optional span wrapper for tracing each auth handler invocation.
	 * Defaults to identity (no tracing).
	 */
	wrapSpan?: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
}

/**
 * Pluggable static asset fetcher. Cloudflare Workers `env.ASSETS` satisfies this shape.
 */
export interface AssetsFetcher {
	fetch(input: string | URL | Request): Promise<Response>;
}
