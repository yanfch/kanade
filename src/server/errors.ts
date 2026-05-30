/** Thrown by route handlers to produce a specific HTTP status code. */
export class AppError extends Error {
	constructor(
		message: string,
		readonly status: 400 | 404 | 409 | 422 | 500 = 500,
	) {
		super(message);
		this.name = "AppError";
	}
}
