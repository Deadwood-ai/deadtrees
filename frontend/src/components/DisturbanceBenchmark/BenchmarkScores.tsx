import type { IBenchmarkEvaluation } from "./types";

export default function BenchmarkScores({
  counts,
}: {
  counts?: IBenchmarkEvaluation["counts"];
}) {
  const percent = (numerator: number, denominator: number) =>
    denominator > 0 ? `${((100 * numerator) / denominator).toFixed(1)}%` : "NA";

  return (
    <div
      className="db-product-scores"

      aria-label="Validation results"
    >
      <span title="Precision = TP / (TP + FP). NA means no predicted positives, or missing counts.">
        Precision{" "}
        <strong>
          {counts ? percent(counts.tp, counts.tp + counts.fp) : "NA"}
        </strong>
      </span>

      <span title="Recall = TP / (TP + FN). NA means no reference positives, or missing counts.">
        Recall{" "}
        <strong>
          {counts ? percent(counts.tp, counts.tp + counts.fn) : "NA"}
        </strong>
      </span>

      <span title="F1 = 2TP / (2TP + FP + FN). NA means an undefined score or missing counts.">
        F1{" "}
        <strong>
          {counts && 2 * counts.tp + counts.fp + counts.fn > 0
            ? (
                (2 * counts.tp) /
                (2 * counts.tp + counts.fp + counts.fn)
              ).toFixed(2)
            : "NA"}
        </strong>
      </span>
    </div>
  );
}
