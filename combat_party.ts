// Parties: !party create/join/invite/accept/decline/list/leave/disband
// (and the !party hunt alias).
// Split out of combat.ts (which re-exports it) to keep every file well
// under Val Town's per-file size ceiling.

import { createPartyInvite, deletePartyInvite, getCharacter, getParty, getPartyInvite, getPartyInvites, getPartyMembers, sqlite } from "./db.ts";
import { sendChatMessage, sendChatMessages } from "./twitch.ts";
import { handlePartyDuelCommand } from "./combat_partyduel.ts";

export async function partySummary(broadcasterId: string, partyName: string) {
  const party = await getParty(broadcasterId, partyName);
  if (!party) return `party ${partyName} was not found`;
  const members = await getPartyMembers(broadcasterId, partyName);
  return `${party.party_name} (leader ${party.owner}): ${
    members.length ? members.join(", ") : "no members"
  }`;
}

export async function handlePartyCommand(
  chatMessage: string,
  username: string,
  display: string,
  broadcasterId: string,
) {
  if (!/^!party(?:\s|$)/i.test(chatMessage)) return false;
  // Alias: "!party hunt ..." is the same as "!dndduel party hunt ..."
  if (/^!party\s+hunt(?:\s|$)/i.test(chatMessage)) {
    return handlePartyDuelCommand(
      chatMessage.trim().replace(/^!party\s+hunt/i, "!dndduel party hunt"),
      username,
      display,
      broadcasterId,
    );
  }
  // Twitch logins are case-insensitive; always normalize for storage/lookup.
  const me = username.toLowerCase();
  const parts = chatMessage.trim().split(/\s+/);
  const action = (parts[1] ?? "list").toLowerCase();
  const sanitizeParty = (raw: string) =>
    (raw ?? "").replace(/^@/, "").toLowerCase().replace(/[^a-z0-9_-]/g, "");
  const name = sanitizeParty(parts[2] ?? "");

  if (action === "create") {
    if (!name) {
      await sendChatMessage(
        `@${display} use !party create <party-name>.`,
        broadcasterId,
      );
      return true;
    }
    if (await getParty(broadcasterId, name)) {
      await sendChatMessage(
        `@${display} that party already exists.`,
        broadcasterId,
      );
      return true;
    }
    // Creator is always owner AND a member so they can invite immediately.
    await sqlite.execute(
      "INSERT INTO parties (broadcaster_id,party_name,owner,created_at) VALUES (?,?,?,?)",
      [broadcasterId, name, me, Date.now()],
    );
    await sqlite.execute(
      "INSERT OR IGNORE INTO party_members (broadcaster_id,party_name,username,joined_at) VALUES (?,?,?,?)",
      [broadcasterId, name, me, Date.now()],
    );
    await sendChatMessage(
      `@${display} party ${name} created. You are the leader and a member. Invite with !party invite @user ${name}`,
      broadcasterId,
    );
    return true;
  }

  if (action === "join") {
    const party = await getParty(broadcasterId, name);
    if (!party) {
      await sendChatMessage(
        `@${display} party ${name} was not found.`,
        broadcasterId,
      );
    } else if (!(await getCharacter(me, broadcasterId))) {
      await sendChatMessage(
        `@${display} create a character before joining a party.`,
        broadcasterId,
      );
    } else {
      await sqlite.execute(
        "INSERT OR IGNORE INTO party_members (broadcaster_id,party_name,username,joined_at) VALUES (?,?,?,?)",
        [broadcasterId, name, me, Date.now()],
      );
      await sendChatMessage(`@${display} joined party ${name}.`, broadcasterId);
    }
    return true;
  }

  if (action === "leave") {
    if (!name) {
      await sendChatMessage(
        `@${display} use !party leave <party-name>.`,
        broadcasterId,
      );
      return true;
    }
    const party = await getParty(broadcasterId, name);
    if (!party) {
      await sendChatMessage(
        `@${display} party ${name} was not found.`,
        broadcasterId,
      );
    } else if (String(party.owner).toLowerCase() === me) {
      await sendChatMessage(
        `@${display} leaders must use !party disband ${name}.`,
        broadcasterId,
      );
    } else {
      await sqlite.execute(
        "DELETE FROM party_members WHERE broadcaster_id = ? AND party_name = ? AND username = ?",
        [broadcasterId, name, me],
      );
      await sendChatMessage(`@${display} left party ${name}.`, broadcasterId);
    }
    return true;
  }

  if (action === "invite") {
    const target = (parts[2] ?? "").replace(/^@/, "").toLowerCase().replace(
      /[,:]+$/,
      "",
    );
    let partyName = sanitizeParty(parts[3] ?? "");

    // If party name omitted, use a party this user owns (or is the only member of).
    if (target && !partyName) {
      const owned = await sqlite.execute(
        "SELECT party_name FROM parties WHERE broadcaster_id = ? AND lower(owner) = ? ORDER BY created_at ASC",
        [broadcasterId, me],
      );
      if (owned.rows.length === 1) {
        partyName = String(owned.rows[0].party_name);
      } else {
        const membership = await sqlite.execute(
          "SELECT party_name FROM party_members WHERE broadcaster_id = ? AND lower(username) = ? ORDER BY party_name",
          [broadcasterId, me],
        );
        if (membership.rows.length === 1) {
          partyName = String(membership.rows[0].party_name);
        }
      }
    }

    if (!target || !partyName) {
      await sendChatMessage(
        `@${display} use !party invite @user <party-name> (party name optional if you only lead/belong to one party).`,
        broadcasterId,
      );
      return true;
    }

    const party = await getParty(broadcasterId, partyName);
    if (!party) {
      await sendChatMessage(
        `@${display} party ${partyName} was not found.`,
        broadcasterId,
      );
      return true;
    }

    // Repair: if this user is the owner but missing from members, add them.
    const ownerName = String(party.owner).toLowerCase();
    if (ownerName === me) {
      await sqlite.execute(
        "INSERT OR IGNORE INTO party_members (broadcaster_id,party_name,username,joined_at) VALUES (?,?,?,?)",
        [broadcasterId, partyName, me, Date.now()],
      );
    }

    const members = (await getPartyMembers(broadcasterId, partyName)).map((m) =>
      m.toLowerCase()
    );
    const isOwner = ownerName === me;
    const isMember = members.includes(me);
    if (!isOwner && !isMember) {
      await sendChatMessage(
        `@${display} only a party member or the leader can invite someone to that party.`,
        broadcasterId,
      );
      return true;
    }
    if (target === me) {
      await sendChatMessage(
        `@${display} you are already in party ${partyName}.`,
        broadcasterId,
      );
      return true;
    }
    if (!(await getCharacter(target, broadcasterId))) {
      await sendChatMessage(
        `@${display} that player needs a saved character first.`,
        broadcasterId,
      );
      return true;
    }
    // Require the invitee's consent — don't add them straight to the roster.
    await createPartyInvite(broadcasterId, partyName, target, me);
    await sendChatMessage(
      `@${display} invited @${target} to party ${partyName}. @${target}: reply !party accept${
        partyName ? ` ${partyName}` : ""
      } or !party decline${partyName ? ` ${partyName}` : ""}.`,
      broadcasterId,
    );
    return true;
  }

  if (action === "accept" || action === "decline") {
    let partyName = sanitizeParty(parts[2] ?? "");
    if (!partyName) {
      const invites = await getPartyInvites(broadcasterId, me);
      if (invites.length === 1) {
        partyName = String(invites[0].party_name);
      } else if (invites.length > 1) {
        await sendChatMessage(
          `@${display} you have pending invites to: ${
            invites.map((i: any) => i.party_name).join(", ")
          }. Use !party ${action} <party-name>.`,
          broadcasterId,
        );
        return true;
      }
    }
    if (!partyName) {
      await sendChatMessage(
        `@${display} you have no pending party invites.`,
        broadcasterId,
      );
      return true;
    }
    const invite = await getPartyInvite(broadcasterId, me, partyName);
    if (!invite) {
      await sendChatMessage(
        `@${display} you have no pending invite to party ${partyName}.`,
        broadcasterId,
      );
      return true;
    }
    await deletePartyInvite(broadcasterId, partyName, me);
    if (action === "decline") {
      await sendChatMessage(
        `@${display} declined the invite to party ${partyName}.`,
        broadcasterId,
      );
      return true;
    }
    const party = await getParty(broadcasterId, partyName);
    if (!party) {
      await sendChatMessage(
        `@${display} party ${partyName} no longer exists.`,
        broadcasterId,
      );
      return true;
    }
    await sqlite.execute(
      "INSERT OR IGNORE INTO party_members (broadcaster_id,party_name,username,joined_at) VALUES (?,?,?,?)",
      [broadcasterId, partyName, me, Date.now()],
    );
    await sendChatMessage(
      `@${display} joined party ${partyName}.`,
      broadcasterId,
    );
    return true;
  }

  if (action === "disband") {
    const party = await getParty(broadcasterId, name);
    if (!party) {
      await sendChatMessage(
        `@${display} party ${name} was not found.`,
        broadcasterId,
      );
    } else if (String(party.owner).toLowerCase() !== me) {
      await sendChatMessage(
        `@${display} only the party leader can disband that party.`,
        broadcasterId,
      );
    } else {
      await sqlite.execute(
        "DELETE FROM party_members WHERE broadcaster_id = ? AND party_name = ?",
        [
          broadcasterId,
          name,
        ],
      );
      await sqlite.execute(
        "DELETE FROM parties WHERE broadcaster_id = ? AND party_name = ?",
        [
          broadcasterId,
          name,
        ],
      );
      await sendChatMessage(
        `@${display} party ${name} disbanded.`,
        broadcasterId,
      );
    }
    return true;
  }

  if (action === "list" || action === "show") {
    if (name) {
      await sendChatMessages(
        `@${display} ${await partySummary(broadcasterId, name)}.`,
        broadcasterId,
      );
    } else {
      const res = await sqlite.execute(
        "SELECT party_name FROM party_members WHERE broadcaster_id = ? AND lower(username) = ? ORDER BY party_name",
        [broadcasterId, me],
      );
      if (!res.rows.length) {
        await sendChatMessage(
          `@${display} you are not in any parties. Create one with !party create <name>.`,
          broadcasterId,
        );
      } else {
        const summaries: string[] = [];
        for (const row of res.rows) {
          summaries.push(
            await partySummary(broadcasterId, String(row.party_name)),
          );
        }
        await sendChatMessages(
          `@${display} your parties — ${summaries.join(" | ")}`,
          broadcasterId,
        );
      }
    }
    return true;
  }

  await sendChatMessage(
    `@${display} Party: !party create <name> | !party join <name> | !party invite @user <name> | !party accept/decline [name] | !party list [name] | !party leave <name> | !party disband <name>.`,
    broadcasterId,
  );
  return true;
}
