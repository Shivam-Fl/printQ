import { COUNTER_CAPACITY_MAX, COUNTER_CAPACITY_MIN, REVEAL_GRACE_OPTIONS } from '@printq/shared';

export const clampCapacity = (value: number): number =>
  Number.isFinite(value)
    ? Math.min(COUNTER_CAPACITY_MAX, Math.max(COUNTER_CAPACITY_MIN, Math.round(value)))
    : COUNTER_CAPACITY_MIN;

export const graceLabel = (seconds: number): string => (seconds < 60 ? `${seconds} s` : `${seconds / 60} min`);

/** Owner settings for how many students the counter serves at once and how long they get to arrive. */
export default function QueueSettings({
  capacity,
  graceSeconds,
  onChange,
}: {
  capacity: number;
  graceSeconds: number;
  onChange: (next: { counterCapacity: number; revealGraceSeconds: number }) => void;
}) {
  return (
    <div className="settings-surface stack">
      <div className="field">
        <label htmlFor="counter-capacity">Counter capacity</label>
        <div className="stepper">
          <button
            type="button"
            className="secondary"
            aria-label="Decrease counter capacity"
            disabled={capacity <= COUNTER_CAPACITY_MIN}
            onClick={() => onChange({ counterCapacity: clampCapacity(capacity - 1), revealGraceSeconds: graceSeconds })}
          >
            −
          </button>
          <input
            id="counter-capacity"
            type="number"
            inputMode="numeric"
            min={COUNTER_CAPACITY_MIN}
            max={COUNTER_CAPACITY_MAX}
            value={capacity}
            onChange={(event) => onChange({ counterCapacity: clampCapacity(Number(event.target.value)), revealGraceSeconds: graceSeconds })}
          />
          <button
            type="button"
            className="secondary"
            aria-label="Increase counter capacity"
            disabled={capacity >= COUNTER_CAPACITY_MAX}
            onClick={() => onChange({ counterCapacity: clampCapacity(capacity + 1), revealGraceSeconds: graceSeconds })}
          >
            +
          </button>
        </div>
        <span className="field-help">
          How many students your counter can serve at once ({COUNTER_CAPACITY_MIN}–{COUNTER_CAPACITY_MAX}). The first {capacity} checked-in
          students are called to the counter; the next {capacity} get a “your turn is coming up” heads-up.
          Students already called are never un-called when you lower this.
        </span>
      </div>
      <div className="field">
        <span className="field-label" id="grace-label">Time to reach the counter</span>
        <div className="segmented" role="radiogroup" aria-labelledby="grace-label">
          {REVEAL_GRACE_OPTIONS.map((seconds) => (
            <button
              key={seconds}
              type="button"
              role="radio"
              aria-checked={graceSeconds === seconds}
              className={graceSeconds === seconds ? 'active' : ''}
              onClick={() => onChange({ counterCapacity: capacity, revealGraceSeconds: seconds })}
            >
              {graceLabel(seconds)}
            </button>
          ))}
        </div>
        <span className="field-help">
          A called student who is not at the counter in this time is marked absent and must check in again at the back of the line.
          Applies to students called from now on.
        </span>
      </div>
    </div>
  );
}
