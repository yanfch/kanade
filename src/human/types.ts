export interface HumanRequest {
	title: string;
	detail?: string;
	options?: string[];
	data?: Record<string, unknown>;
}

export interface HumanResponse {
	decision?: string;
	freeform?: string;
	metadata?: Record<string, unknown>;
}
