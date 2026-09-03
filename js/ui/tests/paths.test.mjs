import test from "node:test";
import assert from "node:assert/strict";

import { haystack, levelBlock } from "../paths.js";

test("path talents render attached stat blocks without a difficulty label", () => {
  const html = levelBlock("3", {
    talents: [{
      name: "Spirit Guide",
      text: "You forge a bond with an animal spirit.",
      stat_blocks: [{
        name: "Raven Spirit",
        book: "occult",
        page: 163,
        descriptor: "1/2 spirit",
        perception: "14 (+4)",
        defense_line: "Defense 13; Health 16; Insanity —; Corruption 0",
        attributes: "Strength 8 (–2), Agility 13 (+3), Intellect 8 (–2), Will 11 (+1)",
        speed: "10; flier (swoop)",
        traits: ["Immune damage from disease or poison"],
        attack_options: ["Talons (melee) +3 with 1 boon (1d6 + 1)"],
        special_attacks: [], special_actions: [], end_of_round: [], magic: [],
      }],
    }],
  });

  assert.match(html, /Raven Spirit/);
  assert.match(html, /Attack Options/);
  assert.doesNotMatch(html, /Difficulty (?:undefined|null)/);
});

test("attached stat blocks remain searchable after leaving talent prose", () => {
  const text = haystack({
    name: "Spiritcaller",
    description: "An animal-spirit guide.",
    levels: {
      6: {
        talents: [{
          name: "Greater Spirit Guide",
          text: "You forge another bond.",
          stat_blocks: [{
            name: "Lizard Spirit",
            descriptor: "1 spirit",
            attack_options: ["Teeth (melee) +3 with 1 boon (3d6)"],
          }],
        }],
      },
    },
  });

  assert.match(text, /lizard spirit/);
  assert.match(text, /teeth \(melee\)/);
});
