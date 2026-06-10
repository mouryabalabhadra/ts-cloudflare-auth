import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { withBearerHandler, type BearerMCPServer } from "../src/bearer";
import type { AuthHooks, BaseProps, BearerAuthRouteGroup } from "../src/types";

function makeMcpServer(): BearerMCPServer & {
	serve: ReturnType<typeof vi.fn>;
	serveSSE: ReturnType<typeof vi.fn>;
} {
	const serve = vi.fn().mockReturnValue({
		fetch: vi.fn().mockResolvedValue(new Response("mcp-ok", { status: 200 })),
	});
	const serveSSE = vi.fn().mockReturnValue({
		fetch: vi.fn().mockResolvedValue(new Response("sse-ok", { status: 200 })),
	});
	return { serve, serveSSE } as unknown as BearerMCPServer & {
		serve: ReturnType<typeof vi.fn>;
		serveSSE: ReturnType<typeof vi.fn>;
	};
}

function ctx(): ExecutionContext & { props?: BaseProps } {
	return {
		waitUntil: vi.fn(),
		passThroughOnException: vi.fn(),
	} as unknown as ExecutionContext;
}

describe("withBearerHandler", () => {
	describe("/bearer/* routes", () => {
		it("returns 400 when authorization header is missing", async () => {
			const app = new Hono();
			withBearerHandler(app, makeMcpServer());
			const res = await app.fetch(
				new Request("https://example.com/bearer/mcp"),
				{},
				ctx(),
			);
			expect(res.status).toBe(400);
			expect(await res.text()).toContain("Bearer token");
		});

		it("returns 400 when x-ts-host is missing and token has no @host suffix", async () => {
			const app = new Hono();
			withBearerHandler(app, makeMcpServer());
			const res = await app.fetch(
				new Request("https://example.com/bearer/mcp", {
					headers: { authorization: "Bearer token-only" },
				}),
				{},
				ctx(),
			);
			expect(res.status).toBe(400);
			expect(await res.text()).toContain("TS Host is required");
		});

		it("invokes McpServer.serve on /bearer/mcp with valid headers", async () => {
			const mcp = makeMcpServer();
			const app = new Hono();
			withBearerHandler(app, mcp);
			const res = await app.fetch(
				new Request("https://example.com/bearer/mcp", {
					headers: {
						authorization: "Bearer abc",
						"x-ts-host": "ts.example.com",
					},
				}),
				{},
				ctx(),
			);
			expect(res.status).toBe(200);
			expect(mcp.serve).toHaveBeenCalledWith("/mcp");
		});

		it("invokes McpServer.serveSSE on /bearer/sse", async () => {
			const mcp = makeMcpServer();
			const app = new Hono();
			withBearerHandler(app, mcp);
			const res = await app.fetch(
				new Request("https://example.com/bearer/sse", {
					headers: {
						authorization: "Bearer abc",
						"x-ts-host": "ts.example.com",
					},
				}),
				{},
				ctx(),
			);
			expect(res.status).toBe(200);
			expect(mcp.serveSSE).toHaveBeenCalledWith("/sse");
		});

		it("accepts host via token@host syntax", async () => {
			const mcp = makeMcpServer();
			const app = new Hono();
			withBearerHandler(app, mcp);
			const res = await app.fetch(
				new Request("https://example.com/bearer/mcp", {
					headers: { authorization: "Bearer abc@ts.example.com" },
				}),
				{},
				ctx(),
			);
			expect(res.status).toBe(200);
		});

		it("sanitizes the host URL onto ctx.props", async () => {
			const mcp = makeMcpServer();
			const app = new Hono();
			withBearerHandler(app, mcp);
			const c = ctx();
			await app.fetch(
				new Request("https://example.com/bearer/mcp", {
					headers: {
						authorization: "Bearer abc",
						"x-ts-host": "ts.example.com/some/path?q=1",
					},
				}),
				{},
				c,
			);
			const props = (c as unknown as { props: BaseProps }).props;
			expect(props.accessToken).toBe("abc");
			expect(props.instanceUrl).toBe("https://ts.example.com");
		});
	});

	describe("/token/* routes", () => {
		it("routes /token/mcp through token family", async () => {
			const mcp = makeMcpServer();
			const app = new Hono();
			withBearerHandler(app, mcp);
			const res = await app.fetch(
				new Request("https://example.com/token/mcp", {
					headers: {
						authorization: "Bearer abc",
						"x-ts-host": "ts.example.com",
					},
				}),
				{},
				ctx(),
			);
			expect(res.status).toBe(200);
			expect(mcp.serve).toHaveBeenCalledWith("/mcp");
		});
	});

	describe("custom prefixes", () => {
		it("mounts on configured prefixes", async () => {
			const mcp = makeMcpServer();
			const app = new Hono();
			withBearerHandler(app, mcp, {
				prefixes: { bearer: "/auth/bearer", token: "/auth/token" },
			});
			const res = await app.fetch(
				new Request("https://example.com/auth/bearer/mcp", {
					headers: {
						authorization: "Bearer abc",
						"x-ts-host": "ts.example.com",
					},
				}),
				{},
				ctx(),
			);
			expect(res.status).toBe(200);
			expect(mcp.serve).toHaveBeenCalled();
		});
	});

	describe("hooks", () => {
		it("invokes onBearerMetric with correct route group", async () => {
			const mcp = makeMcpServer();
			const app = new Hono();
			const onBearerMetric = vi.fn();
			withBearerHandler(app, mcp, { hooks: { onBearerMetric } });

			await app.fetch(
				new Request("https://example.com/bearer/mcp", {
					headers: {
						authorization: "Bearer abc",
						"x-ts-host": "ts.example.com",
					},
				}),
				{},
				ctx(),
			);
			expect(onBearerMetric).toHaveBeenCalled();
			const [status, , , group] = onBearerMetric.mock.calls[0];
			expect(status).toBe(200);
			expect(group as BearerAuthRouteGroup).toBe("bearer_mcp");
		});

		it("reports token_sse group on /token/sse", async () => {
			const mcp = makeMcpServer();
			const app = new Hono();
			const onBearerMetric = vi.fn();
			withBearerHandler(app, mcp, { hooks: { onBearerMetric } });

			await app.fetch(
				new Request("https://example.com/token/sse", {
					headers: {
						authorization: "Bearer abc",
						"x-ts-host": "ts.example.com",
					},
				}),
				{},
				ctx(),
			);
			expect(onBearerMetric.mock.calls[0][3]).toBe("token_sse");
		});

		it("reports 400 status on missing auth header", async () => {
			const mcp = makeMcpServer();
			const app = new Hono();
			const onBearerMetric = vi.fn();
			withBearerHandler(app, mcp, { hooks: { onBearerMetric } });
			await app.fetch(
				new Request("https://example.com/bearer/mcp"),
				{},
				ctx(),
			);
			expect(onBearerMetric.mock.calls[0][0]).toBe(400);
		});

		it("calls extendProps to enrich the base props", async () => {
			const mcp = makeMcpServer();
			const app = new Hono();
			const extendProps = vi.fn((_req: Request, base: BaseProps) => ({
				...base,
				custom: "enriched",
			}));
			const hooks: AuthHooks<BaseProps & { custom: string }> = {
				extendProps: extendProps as never,
			};
			withBearerHandler(app, mcp, { hooks });
			const c = ctx();
			await app.fetch(
				new Request("https://example.com/bearer/mcp", {
					headers: {
						authorization: "Bearer abc",
						"x-ts-host": "ts.example.com",
					},
				}),
				{},
				c,
			);
			expect(extendProps).toHaveBeenCalled();
			const props = (c as unknown as { props: BaseProps & { custom: string } })
				.props;
			expect(props.custom).toBe("enriched");
		});
	});
});
