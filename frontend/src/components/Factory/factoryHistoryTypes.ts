export interface FactoryHistoryPoint {
	start: string;
	end: string;
	partial: boolean;
	registered: number;
	uploaded: number | null;
	completed: number | null;
	failed: number | null;
	indexing: number | null;
	emails: number | null;
	reports: number | null;
	publications: number | null;
	input_gib: number | null;
	size_samples: number;
	contributors: number | null;
	returning_contributors: number | null;
	p50: number | null;
	p90: number | null;
	timing_samples: number;
}

export interface FactoryHistory {
	as_of: string;
	first_registration: string | null;
	year: number | null;
	years: number[];
	upload_since: string | null;
	run_since: string | null;
	report_since: string | null;
	publication_since: string | null;
	email_since: string | null;
	coverage: {
		datasets: number;
		upload_evidence: number;
		upload_sizes: number;
		timing_pairs: number;
		measured_uploads: number;
		ready_now: number;
	};
	series: FactoryHistoryPoint[];
}
