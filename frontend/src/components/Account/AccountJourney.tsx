import type { JourneyStep } from "./accountJourney";
import UploadRequirements from "./UploadRequirements";

interface AccountJourneyProps {
  steps: JourneyStep[] | null;
  failed: boolean;
}

/** The contributor's numbers as upload, process, publish; a short how-to for accounts without datasets. */
export default function AccountJourney({ steps, failed }: AccountJourneyProps) {
  return (
    <section aria-label="Your data on DeadTrees" className="mb-6 rounded-2xl border border-slate-200 bg-white">
      {steps === null ? (
        <p className="m-0 px-6 py-6 text-sm text-slate-500" role="status">
          {failed ? "Your numbers could not be loaded right now. Reload the page to try again." : "Loading your numbers…"}
        </p>
      ) : steps[0].value === 0 ? (
        <GettingStarted />
      ) : (
        <ol className="m-0 grid list-none grid-cols-1 p-0 sm:grid-cols-3 sm:divide-x sm:divide-slate-200">
          {steps.map((step, index) => (
            <JourneyColumn key={step.key} step={step} number={index + 1} />
          ))}
        </ol>
      )}
    </section>
  );
}

function JourneyColumn({ step, number }: { step: JourneyStep; number: number }) {
  return (
    <li className="flex min-w-0 flex-col gap-3 px-6 py-5" data-testid={`journey-${step.key}`}>
      <p className="m-0 text-xs font-semibold uppercase tracking-wider text-slate-500">
        <span className="tabular-nums">{String(number).padStart(2, "0")}</span>
        <span className="ml-2">{step.title}</span>
      </p>
      <div>
        <p className="m-0 text-4xl font-semibold tabular-nums tracking-tight text-slate-900">{step.value.toLocaleString()}</p>
        <p className="m-0 mt-0.5 text-sm text-slate-500">{step.label}</p>
        {step.progress !== undefined && (
          <div
            role="progressbar"
            aria-label={`${step.title} progress`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(step.progress * 100)}
            className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100"
          >
            <div className="h-full rounded-full bg-[#287254]" style={{ width: `${Math.round(step.progress * 100)}%` }} />
          </div>
        )}
      </div>
      <dl className="m-0 space-y-1.5 text-sm">
        {step.details.map((detail) => (
          <div key={detail.label} className="flex items-baseline justify-between gap-3">
            <dt className="min-w-0 truncate text-slate-500">{detail.label}</dt>
            <dd className="m-0 shrink-0 font-medium tabular-nums text-slate-900">{detail.value.toLocaleString()}</dd>
          </div>
        ))}
      </dl>
    </li>
  );
}

const GETTING_STARTED = [
  { title: "Upload", text: "Add drone imagery with Upload Data below." },
  { title: "Process", text: "DeadTrees maps deadwood and forest cover in it. We can email you when it finishes." },
  { title: "Publish", text: "Get a citable DOI through FreiDATA under Published Datasets." },
];

function GettingStarted() {
  return (
    <div data-testid="journey-getting-started">
      <ol className="m-0 grid list-none grid-cols-1 p-0 sm:grid-cols-3 sm:divide-x sm:divide-slate-200">
        {GETTING_STARTED.map((step, index) => (
          <li key={step.title} className="flex gap-3 px-6 py-5">
            <span
              aria-hidden
              className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                index === 0 ? "bg-[#1B5E35] text-white" : "bg-slate-100 text-slate-500"
              }`}
            >
              {index + 1}
            </span>
            <div>
              <p className="m-0 text-sm font-semibold text-slate-900">{step.title}</p>
              <p className="m-0 text-sm text-slate-500">{step.text}</p>
            </div>
          </li>
        ))}
      </ol>
      <div className="border-t border-slate-200 px-6 py-4">
        <p className="m-0 mb-2 text-sm font-semibold text-slate-900">What you can upload</p>
        <UploadRequirements />
      </div>
    </div>
  );
}
