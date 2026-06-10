import type { AssetsFetcher } from "./types";

export async function renderTokenCallback(
	instanceUrl: string,
	oauthReqInfo: unknown,
	assets: AssetsFetcher,
	origin: string,
): Promise<string> {
	const parsedOAuthReqInfo =
		typeof oauthReqInfo === "string" ? JSON.parse(oauthReqInfo) : oauthReqInfo;
	const oauthReqInfoJson = JSON.stringify(parsedOAuthReqInfo);

	try {
		const htmlResponse = await assets.fetch(`${origin}/oauth-callback.html`);
		if (!htmlResponse.ok) {
			throw new Error("Failed to load oauth-callback.html");
		}
		let htmlContent = await htmlResponse.text();

		const cssResponse = await assets.fetch(`${origin}/oauth-callback.css`);
		if (!cssResponse.ok) {
			throw new Error("Failed to load oauth-callback.css");
		}
		const css = await cssResponse.text();

		const jsResponse = await assets.fetch(`${origin}/oauth-callback.js`);
		if (!jsResponse.ok) {
			throw new Error("Failed to load oauth-callback.js");
		}
		const js = await jsResponse.text();

		htmlContent = htmlContent.replace("{{OAUTH_REQ_INFO}}", oauthReqInfoJson);

		htmlContent = htmlContent.replace(
			'<link rel="stylesheet" href="oauth-callback.css">',
			`<style>${css}</style>`,
		);

		htmlContent = htmlContent.replace(
			'<script src="oauth-callback.js"></script>',
			`<script>window.INSTANCE_URL = '${instanceUrl}';</script>\n    <script>${js}</script>`,
		);

		return htmlContent;
	} catch (error) {
		console.error("Error loading static files:", error);
		return `
        <!DOCTYPE html>
        <html>
        <head>
            <title>Error - Authorization</title>
            <style>
                body {
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                    display: flex; justify-content: center; align-items: center;
                    height: 100vh; margin: 0; background-color: #f8f9fa; color: #2c3e50;
                }
                .container {
                    text-align: center; padding: 3rem; background: white;
                    border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.1);
                    max-width: 480px; width: 90%;
                }
                h2 { color: #dc3545; margin-bottom: 1rem; }
            </style>
        </head>
        <body>
            <div class="container">
                <h2>Authorization Error</h2>
                <p>Failed to load authorization page. Please try again or contact support.</p>
                <p>Error: ${error instanceof Error ? error.message : "Unknown error"}</p>
            </div>
        </body>
        </html>
        `;
	}
}
