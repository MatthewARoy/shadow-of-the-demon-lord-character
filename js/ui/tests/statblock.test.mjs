import test from "node:test";
import assert from "node:assert/strict";

import { statBlockHtml } from "../statblock.js";

const emptySections = {
  traits: [], attack_options: [], special_attacks: [], special_actions: [],
  end_of_round: [], magic: [],
};

test("template stat blocks render adjustments instead of absolute creature labels", () => {
  const html = statBlockHtml({
    ...emptySections,
    name: "Animated Corpse",
    book: "occult",
    page: 133,
    kind: "template",
    difficulty: "STEP",
    difficulty_adjustment: -1,
    descriptor: "frightening undead",
    perception: "5 (–5); sightless",
    defense_line: "Insanity —; Corruption —",
    attributes: "Agility –2, Intellect —, Will +5",
    speed: "–4",
  });

  assert.match(html, /Template/);
  assert.match(html, /Difficulty −1 step/);
  assert.doesNotMatch(html, /Difficulty STEP/);
  assert.match(html, />frightening undead</);
  assert.doesNotMatch(html, />Size frightening undead</);
});

test("ordinary creature stat blocks retain their existing labels", () => {
  const html = statBlockHtml({
    ...emptySections,
    name: "Animated Corpse",
    book: "core",
    page: 218,
    difficulty: "1",
    descriptor: "1 undead",
    perception: "5 (–5); sightless",
    defense_line: "Defense 8; Health 10",
    attributes: "Strength 10 (+0)",
    speed: "6",
  });

  assert.match(html, /Difficulty 1/);
  assert.match(html, />Size 1 undead</);
  assert.doesNotMatch(html, /Template/);
});
