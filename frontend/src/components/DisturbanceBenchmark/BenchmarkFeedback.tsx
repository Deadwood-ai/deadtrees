import { useState } from "react";
import { useAuth } from "../../hooks/useAuthProvider";
import type { IBenchmarkSite } from "./types";

export default function BenchmarkFeedback({ site }: { site: IBenchmarkSite }) {
  const { session } = useAuth();
  const [comment, setComment] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">(
    "idle",
  );
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!session || !comment.trim() || state === "sending") return;
    setState("sending");
    try {
      const response = await fetch("/api/v1/disturbance-benchmark/feedback", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ siteId: site.id, comment: comment.trim() }),
      });
      if (!response.ok) throw new Error("Comment not accepted");
      const result = await response.json();
      if (result.accepted !== true) throw new Error("Comment not accepted");
      setComment("");
      setState("sent");
    } catch {
      setState("error");
    }
  }
  return (
    <details className="db-feedback">
      <summary>Give feedback on this reference site</summary>
      <p>
        Notice an issue in the reference or temporal evidence? Leave a comment
        for the team.
      </p>
      <form onSubmit={submit}>
        <label htmlFor="db-feedback-comment">Your comment</label>
        <textarea
          id="db-feedback-comment"
          rows={4}
          maxLength={4000}
          value={comment}
          disabled={state === "sending"}
          onChange={(event) => {
            setComment(event.target.value);
            setState("idle");
          }}
        />
        <button
          type="submit"
          className="db-feedback-email"
          disabled={!session || !comment.trim() || state === "sending"}
        >
          {state === "sending" ? "Sending…" : "Send comment"}
        </button>
        {state === "sent" && (
          <p role="status">
            Thank you. Your comment has been sent to the team.
          </p>
        )}
        {state === "error" && (
          <p role="alert">Your comment could not be sent. Please try again.</p>
        )}
      </form>
    </details>
  );
}
