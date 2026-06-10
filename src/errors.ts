export class McpServerError extends Error {
	public readonly errorJson: unknown;
	public readonly statusCode: number;

	constructor(errorJson: unknown, statusCode: number) {
		const message =
			typeof errorJson === "string"
				? errorJson
				: (errorJson as { message?: string; error?: string })?.message ||
					(errorJson as { message?: string; error?: string })?.error ||
					"Unknown error occurred";

		super(message);

		this.name = "McpServerError";
		this.errorJson = errorJson;
		this.statusCode = statusCode;

		console.error("Error:", this.message);

		Object.setPrototypeOf(this, McpServerError.prototype);
	}

	toJSON() {
		return {
			name: this.name,
			message: this.message,
			statusCode: this.statusCode,
			errorJson: this.errorJson,
			stack: this.stack,
		};
	}

	getUserMessage(): string {
		const obj = this.errorJson as { userMessage?: string } | null | undefined;
		if (typeof obj === "object" && obj?.userMessage) {
			return obj.userMessage;
		}
		return this.message;
	}
}
