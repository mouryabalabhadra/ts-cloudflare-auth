export const PUBLIC_ROUTES = {
	root: "/",
	authorize: "/authorize",
	callback: "/callback",
	storeToken: "/store-token",
	oauthToken: "/token",
	register: "/register",
	mcp: "/mcp",
	sse: "/sse",
	bearerMcp: "/bearer/mcp",
	bearerSse: "/bearer/sse",
	tokenMcp: "/token/mcp",
	tokenSse: "/token/sse",
} as const;

export type PublicRoutes = typeof PUBLIC_ROUTES;

export const PUBLIC_ROUTE_PREFIXES = {
	bearer: "/bearer",
	token: "/token",
} as const;

export type PublicRoutePrefixes = typeof PUBLIC_ROUTE_PREFIXES;
