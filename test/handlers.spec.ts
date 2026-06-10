import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodeBase64Url } from "hono/utils/encode";
import { createAuthApp } from "../src/handlers";
import type { AuthMetricName, ServerInfo } from "../src/types";

const serverInfo: ServerInfo = {
	name: "Test Server",
	description: "Test description",
};

function makeOauthProvider(overrides: Partial<Record<string, unknown>> = {}) {
	return {
		parseAuthRequest: vi.fn().mockResolvedValue({
			clientId: "client-123",
			codeChallenge: "challenge",
			codeChallengeMethod: "S256",
			scope: ["read"],
		}),
		lookupClient: vi.fn().mockResolvedValue({
			clientId: "client-123",
			clientName: "Test Client",
			registrationDate: 123,
		}),
		completeAuthorization: vi.fn().mockResolvedValue({
			redirectTo: "https://example.com/callback?code=abc",
		}),
		...overrides,
	};
}

function makeAssets(payloads: Record<string, string>) {
	return {
		fetch: vi.fn().mockImplementation((url: string) => {
			const path = new URL(url).pathname;
			const body = payloads[path];
			if (body === undefined) {
				return Promise.resolve(new Response("not found", { status: 404 }));
			}
			return Promise.resolve(new Response(body, { status: 200 }));
		}),
	};
}

function makeEnv(extra: Record<string, unknown> = {}) {
	return {
		OAUTH_PROVIDER: makeOauthProvider(),
		...extra,
	} as any;
}

function ctx(): ExecutionContext {
	return {
		waitUntil: vi.fn(),
		passThroughOnException: vi.fn(),
	} as unknown as ExecutionContext;
}

describe("createAuthApp", () => {
	describe("GET /authorize", () => {
		it("renders approval dialog for valid request", async () => {
			const app = createAuthApp({ serverInfo });
			const env = makeEnv();
			const res = await app.fetch(
				new Request("https://example.com/authorize"),
				env,
				ctx(),
			);
			expect(res.status).toBe(200);
			const html = await res.text();
			expect(html).toContain("Test Server wants access");
		});

		it("returns 500 when client ID is missing", async () => {
			const app = createAuthApp({ serverInfo });
			const env = makeEnv({
				OAUTH_PROVIDER: makeOauthProvider({
					parseAuthRequest: vi.fn().mockResolvedValue({}),
				}),
			});
			const res = await app.fetch(
				new Request("https://example.com/authorize"),
				env,
				ctx(),
			);
			expect(res.status).toBe(500);
		});

		it("returns 500 when PKCE code challenge is missing", async () => {
			const app = createAuthApp({ serverInfo });
			const env = makeEnv({
				OAUTH_PROVIDER: makeOauthProvider({
					parseAuthRequest: vi.fn().mockResolvedValue({ clientId: "abc" }),
				}),
			});
			const res = await app.fetch(
				new Request("https://example.com/authorize"),
				env,
				ctx(),
			);
			expect(res.status).toBe(500);
			expect(await res.text()).toContain("PKCE");
		});

		it("returns 500 when PKCE code challenge method is not S256", async () => {
			const app = createAuthApp({ serverInfo });
			const env = makeEnv({
				OAUTH_PROVIDER: makeOauthProvider({
					parseAuthRequest: vi.fn().mockResolvedValue({
						clientId: "abc",
						codeChallenge: "x",
						codeChallengeMethod: "plain",
					}),
				}),
			});
			const res = await app.fetch(
				new Request("https://example.com/authorize"),
				env,
				ctx(),
			);
			expect(res.status).toBe(500);
			expect(await res.text()).toContain("S256");
		});
	});

	describe("POST /authorize", () => {
		const oauthReqInfo = {
			clientId: "client-123",
			scope: ["read"],
			redirectUri: "https://example.com/callback",
		};

		function postBody(instanceUrl: string) {
			const state = btoa(JSON.stringify({ oauthReqInfo }));
			const form = new URLSearchParams();
			form.append("instanceUrl", instanceUrl);
			form.append("state", state);
			return new Request("https://example.com/authorize", {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: form.toString(),
			});
		}

		it("redirects to free-trial callback for team/my instance", async () => {
			const app = createAuthApp({ serverInfo });
			const res = await app.fetch(
				postBody("https://team1.thoughtspot.cloud"),
				makeEnv(),
				ctx(),
			);
			// Response.redirect returns 302 by default
			expect([301, 302, 307]).toContain(res.status);
			const loc = res.headers.get("location") ?? "";
			expect(loc).toContain("/callback");
			expect(loc).toContain("instanceUrl=https");
		});

		it("redirects to SAML for non-trial instance", async () => {
			const app = createAuthApp({ serverInfo });
			const res = await app.fetch(
				postBody("https://custom.thoughtspot.cloud"),
				makeEnv(),
				ctx(),
			);
			expect([301, 302, 307]).toContain(res.status);
			const loc = res.headers.get("location") ?? "";
			expect(loc).toContain("callosum/v1/saml/login");
		});

		it("returns 400 when instance URL is missing", async () => {
			const app = createAuthApp({ serverInfo });
			const form = new URLSearchParams();
			form.append(
				"state",
				btoa(JSON.stringify({ oauthReqInfo })),
			);
			const req = new Request("https://example.com/authorize", {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: form.toString(),
			});
			const res = await app.fetch(req, makeEnv(), ctx());
			expect(res.status).toBe(400);
		});
	});

	describe("GET /callback", () => {
		const oauthReqInfo = { clientId: "c" };
		const encoded = encodeBase64Url(
			new TextEncoder().encode(JSON.stringify(oauthReqInfo))
				.buffer as ArrayBuffer,
		);

		it("renders the token callback HTML", async () => {
			const app = createAuthApp({
				serverInfo,
				assetsFetcher: makeAssets({
					"/oauth-callback.html": "<html>{{OAUTH_REQ_INFO}}</html>",
					"/oauth-callback.css": ".x{}",
					"/oauth-callback.js": "console.log('x')",
				}),
			});
			const url = `https://example.com/callback?instanceUrl=${encodeURIComponent("https://ts.example.com")}&oauthReqInfo=${encoded}`;
			const res = await app.fetch(new Request(url), makeEnv(), ctx());
			expect(res.status).toBe(200);
			expect(res.headers.get("content-type")).toContain("text/html");
			const body = await res.text();
			expect(body).toContain(JSON.stringify(oauthReqInfo));
		});

		it("returns 400 when instanceUrl is missing", async () => {
			const app = createAuthApp({
				serverInfo,
				assetsFetcher: makeAssets({}),
			});
			const res = await app.fetch(
				new Request(`https://example.com/callback?oauthReqInfo=${encoded}`),
				makeEnv(),
				ctx(),
			);
			expect(res.status).toBe(400);
		});

		it("returns 400 when oauthReqInfo is missing", async () => {
			const app = createAuthApp({
				serverInfo,
				assetsFetcher: makeAssets({}),
			});
			const res = await app.fetch(
				new Request(
					"https://example.com/callback?instanceUrl=https://ts.example.com",
				),
				makeEnv(),
				ctx(),
			);
			expect(res.status).toBe(400);
		});

		it("returns 500 when no ASSETS binding and no fetcher", async () => {
			const app = createAuthApp({ serverInfo });
			const url = `https://example.com/callback?instanceUrl=https://ts.example.com&oauthReqInfo=${encoded}`;
			const res = await app.fetch(new Request(url), makeEnv(), ctx());
			expect(res.status).toBe(500);
		});
	});

	describe("POST /store-token", () => {
		const validBody = {
			token: { data: { token: "abc-token" } },
			oauthReqInfo: { clientId: "client-123", scope: ["read"] },
			instanceUrl: "https://ts.example.com",
		};

		it("completes authorization and returns redirectTo on success", async () => {
			const app = createAuthApp({ serverInfo });
			const env = makeEnv();
			const res = await app.fetch(
				new Request("https://example.com/store-token", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(validBody),
				}),
				env,
				ctx(),
			);
			expect(res.status).toBe(200);
			const json = (await res.json()) as { redirectTo: string };
			expect(json.redirectTo).toContain("/callback");
			expect(env.OAUTH_PROVIDER.completeAuthorization).toHaveBeenCalled();
		});

		it("returns 400 for invalid JSON", async () => {
			const app = createAuthApp({ serverInfo });
			const res = await app.fetch(
				new Request("https://example.com/store-token", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: "not-json",
				}),
				makeEnv(),
				ctx(),
			);
			expect(res.status).toBe(400);
		});

		it("returns 400 for missing required fields", async () => {
			const app = createAuthApp({ serverInfo });
			const res = await app.fetch(
				new Request("https://example.com/store-token", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ token: validBody.token }),
				}),
				makeEnv(),
				ctx(),
			);
			expect(res.status).toBe(400);
		});
	});

	describe("hooks", () => {
		it("invokes onAuthMetric on authorize requests", async () => {
			const onAuthMetric = vi.fn();
			const app = createAuthApp({ serverInfo, hooks: { onAuthMetric } });
			await app.fetch(
				new Request("https://example.com/authorize"),
				makeEnv(),
				ctx(),
			);
			expect(onAuthMetric).toHaveBeenCalled();
			const [name, status] = onAuthMetric.mock.calls[0];
			expect(name as AuthMetricName).toBe("oauth_authorize_requests_total");
			expect(status).toBe(200);
		});

		it("invokes onAuthMetric on store-token success", async () => {
			const onAuthMetric = vi.fn();
			const app = createAuthApp({ serverInfo, hooks: { onAuthMetric } });
			await app.fetch(
				new Request("https://example.com/store-token", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						token: { data: { token: "t" } },
						oauthReqInfo: { clientId: "c", scope: [] },
						instanceUrl: "https://ts.example.com",
					}),
				}),
				makeEnv(),
				ctx(),
			);
			expect(onAuthMetric).toHaveBeenCalled();
			expect(onAuthMetric.mock.calls[0][0]).toBe("oauth_store_token_total");
		});

		it("invokes wrapSpan around each handler", async () => {
			const wrapSpan = vi.fn(
				async <T>(_n: string, fn: () => Promise<T>) => fn(),
			);
			const app = createAuthApp({ serverInfo, hooks: { wrapSpan } });
			await app.fetch(
				new Request("https://example.com/authorize"),
				makeEnv(),
				ctx(),
			);
			expect(wrapSpan).toHaveBeenCalled();
			expect(wrapSpan.mock.calls[0][0]).toBe("authorize-get");
		});
	});

	describe("extraRoutes", () => {
		it("registers consumer-provided extra routes", async () => {
			const extra = vi.fn((app: ReturnType<typeof createAuthApp>) => {
				app.get("/custom", (c) => c.text("custom-ok"));
			});
			const app = createAuthApp({ serverInfo, extraRoutes: extra });
			expect(extra).toHaveBeenCalled();

			const res = await app.fetch(
				new Request("https://example.com/custom"),
				makeEnv(),
				ctx(),
			);
			expect(res.status).toBe(200);
			expect(await res.text()).toBe("custom-ok");
		});
	});
});
