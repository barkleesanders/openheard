import { Button } from "@openheard/ui/components/button";
import { useId, useRef, useState } from "react";

type UpdateAction =
  | { action: "request"; email: string; postId?: number }
  | { action: "confirm" | "unsubscribe"; id: string; token: string };

async function submitUpdate(action: UpdateAction) {
  const response = await fetch("/api/updates", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(action),
    credentials: "same-origin",
    referrerPolicy: "no-referrer",
  });
  const body: unknown = await response.json();
  if (!response.ok || !body || typeof body !== "object" || !("ok" in body) || body.ok !== true)
    throw new Error("Could not update your subscription. Please try again later.");
}

export function SubscriptionForm({ postId }: { postId?: number }) {
  const id = useId();
  const pending = useRef(false);
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const [error, setError] = useState("");
  return (
    <form
      data-traks-ignore="true"
      className="flex flex-col gap-2"
      onSubmit={async (event) => {
        event.preventDefault();
        if (pending.current) return;
        pending.current = true;
        setState("busy");
        setError("");
        try {
          await submitUpdate({ action: "request", email, ...(postId === undefined ? {} : { postId }) });
          setState("done");
        } catch {
          pending.current = false;
          setState("idle");
          setError("Could not request updates. Please try again later.");
        }
      }}
    >
      <label htmlFor={id} className="text-xs text-muted-foreground">
        Email address
      </label>
      <input
        id={id}
        name="email"
        type="email"
        autoComplete="email"
        required
        maxLength={254}
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        disabled={state !== "idle"}
        placeholder="you@company.com"
        className="h-9 w-full min-w-0 rounded-lg border border-input bg-card px-2.5 text-[13px] placeholder:text-faint focus-visible:outline-ring"
      />
      <Button type="submit" size="sm" disabled={state !== "idle"}>
        {state === "busy" ? "Requesting…" : state === "done" ? "Request received" : "Get email updates"}
      </Button>
      <p role="status" className="text-xs leading-relaxed text-muted-foreground">
        {state === "done"
          ? "If confirmation is needed, check your inbox. Follow the link to confirm your subscription."
          : "Confirm by email to subscribe. Unsubscribe from any update."}
      </p>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </form>
  );
}

export function SubscriptionAction({ mode, id, token }: { mode: string; id: string; token: string }) {
  const pending = useRef(false);
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const [error, setError] = useState("");
  const valid =
    (mode === "confirm" || mode === "unsubscribe") && /^[a-f0-9-]{36}$/i.test(id) && /^[a-f0-9]{64}$/.test(token);
  const confirm = mode === "confirm";
  return (
    <div className="mx-auto flex w-full max-w-lg flex-col gap-4 px-6 py-16" data-traks-ignore="true">
      <h1 className="text-2xl font-semibold">
        {!valid ? "Subscription link unavailable" : confirm ? "Confirm email updates" : "Unsubscribe from updates"}
      </h1>
      <p role="status" className="text-sm leading-relaxed text-muted-foreground">
        {!valid
          ? "Open the full link from your email, or request a new confirmation from the feedback board."
          : state === "done"
            ? confirm
              ? "Your subscription is confirmed."
              : "You are unsubscribed from these updates."
            : confirm
              ? "Choose Confirm subscription to receive the updates you requested."
              : "Choose Unsubscribe to stop receiving these updates."}
      </p>
      {valid ? (
        <Button
          type="button"
          disabled={state !== "idle"}
          onClick={async () => {
            if (pending.current) return;
            pending.current = true;
            setState("busy");
            setError("");
            try {
              await submitUpdate({ action: confirm ? "confirm" : "unsubscribe", id, token });
              setState("done");
            } catch {
              pending.current = false;
              setState("idle");
              setError("This link could not be used. It may have expired. Request a new link or try again later.");
            }
          }}
        >
          {state === "busy"
            ? "Updating…"
            : state === "done"
              ? "Updated"
              : confirm
                ? "Confirm subscription"
                : "Unsubscribe"}
        </Button>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <a href="/" className="text-sm text-link underline">
        Back to feedback
      </a>
    </div>
  );
}
