"use client";

import { useActionState } from "react";
import { invite, type InviteState } from "./invite-actions";

export function InviteForm() {
  const [state, action, pending] = useActionState<InviteState, FormData>(invite, null);
  return (
    <form action={action}>
      <h2>Invite a teammate</h2>
      <label>
        Email <input name="email" type="email" required />
      </label>
      <label>
        Role{" "}
        <select name="role" defaultValue="member">
          <option value="admin">Admin</option>
          <option value="member">Member</option>
          <option value="designer">Designer</option>
          <option value="read_only">Read only</option>
        </select>
      </label>
      <button type="submit" disabled={pending}>
        Send invite
      </button>
      {state?.error && <p role="alert">{state.error}</p>}
      {state?.sentTo && <p>Invitation emailed to {state.sentTo}.</p>}
      {state?.shareLink && (
        <p>
          Email is not configured, so send this link yourself (shown once, valid 7 days):{" "}
          <code>{state.shareLink}</code>
        </p>
      )}
    </form>
  );
}
