import { assertEquals } from "jsr:@std/assert@1";
import { heardVoiceCommand } from "./voice_commands.ts";

const heard = (t: string) => heardVoiceCommand(t)?.command ?? null;

Deno.test("heardVoiceCommand hears join said on its own", () => {
  assertEquals(heard("Join!"), "!join");
  assertEquals(heard("join"), "!join");
  assertEquals(heard("Let's join."), "!join");
  assertEquals(heard("Okay, join!"), "!join");
  assertEquals(heard("Bang join."), "!join");
  assertEquals(heard("exclamation point join"), "!join");
  assertEquals(heard("Join, join, join!"), "!join");
  assertEquals(heard("Alright chat. Join in!"), "!join");
});

Deno.test("heardVoiceCommand hears rally said on its own", () => {
  assertEquals(heard("Rally!"), "!rally");
  assertEquals(heard("Let's rally."), "!rally");
  assertEquals(heard("Rally up, everyone."), "!rally");
  assertEquals(heard("Sound the war horn!"), "!rally");
  assertEquals(heard("Okay. Rally the troops!"), "!rally");
});

Deno.test("heardVoiceCommand ignores the words inside other sentences", () => {
  assertEquals(heard("join the discord"), null);
  assertEquals(heard("thanks for joining"), null);
  assertEquals(heard("you should join us next time"), null);
  assertEquals(heard("that was a great rally in tennis"), null);
  assertEquals(heard("rallying the team"), null);
  assertEquals(heard("hello chat"), null);
});
