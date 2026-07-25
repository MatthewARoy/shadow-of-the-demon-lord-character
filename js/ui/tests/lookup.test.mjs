import { test } from "node:test";
import assert from "node:assert/strict";
import { searchAll } from "../lookup.js";

const GEAR = [
  { name: "Sling", category: "Ranged Weapons", damage: "1d3", hands: "Off",
    properties: "Range (medium), uses stones", price: "5 cp", availability: "C" },
  { name: "Bastard sword or warhammer", category: "Heavy Melee Weapons",
    damage: "2d6", hands: "One", properties: "Cumbersome", price: "1 gc",
    availability: "R", requirement: "Strength 13" },
  { name: "Bastard sword or warhammer", category: "Military Melee Weapons",
    damage: "1d6+2", hands: "One", properties: "", price: "5 ss", availability: "U" },
  { name: "Hard Leather", type: "Light Armor", defense: "Agility+2",
    price: "5 ss", availability: "C", requirement: "Strength 11" },
];

const RULES = [
  { t: "Dazed", b: "core", p: 42, x: "A dazed creature cannot use actions." },
  { t: "Improvised Weapons", b: "core", p: 105,
    x: "You can also attack with objects you find around you. A frying pan, a door ripped from its hinges, or a petrified halfling can all serve." },
  { t: "Knock Down", b: "core", p: 53,
    x: "Make a Strength attack roll against the target's Agility. On a success, the target falls prone." },
];

test("sling returns a structured gear result, not prose", () => {
  const { gear } = searchAll(RULES, GEAR, "sling");
  assert.equal(gear.length, 1);
  assert.equal(gear[0].name, "Sling");
  assert.equal(gear[0].damage, "1d3");
  assert.equal(gear[0].properties, "Range (medium), uses stones");
});

test("both duplicate-named weapons survive as distinct results", () => {
  const { gear } = searchAll(RULES, GEAR, "bastard sword");
  assert.equal(gear.length, 2);
  assert.notEqual(gear[0].category, gear[1].category);
});

test("dazed returns the rule and no gear card", () => {
  const { rules, gear } = searchAll(RULES, GEAR, "dazed");
  assert.equal(gear.length, 0);
  assert.equal(rules[0].t, "Dazed");
});

test("gear and rules come back in separate buckets", () => {
  const res = searchAll(RULES, GEAR, "weapons");
  assert.ok(Array.isArray(res.rules));
  assert.ok(Array.isArray(res.gear));
});

test("an empty query returns nothing rather than everything", () => {
  const { rules, gear } = searchAll(RULES, GEAR, "   ");
  assert.equal(rules.length, 0);
  assert.equal(gear.length, 0);
});

test("gear must match every term, so a rules-only query stays clean", () => {
  const { gear } = searchAll(RULES, GEAR, "knock down");
  assert.equal(gear.length, 0);
});

test("an exact name match outranks a partial one", () => {
  const { gear } = searchAll(RULES, GEAR, "hard leather");
  assert.equal(gear[0].name, "Hard Leather");
});

test("armor is searchable by its type", () => {
  const { gear } = searchAll(RULES, GEAR, "light armor");
  assert.ok(gear.some((g) => g.name === "Hard Leather"));
});

test("rules results are capped by the quota", () => {
  const many = Array.from({ length: 40 }, (_, i) => ({
    t: `Rule ${i}`, b: "core", p: i, x: "the target falls prone and is dazed",
  }));
  const { rules } = searchAll(many, GEAR, "prone");
  assert.ok(rules.length <= 15, `expected <= 15 rules, got ${rules.length}`);
});

test("gear results are capped by the quota", () => {
  const many = Array.from({ length: 30 }, (_, i) => ({
    name: `Test Blade ${i}`, category: "Blades", price: "1 gc",
  }));
  const { gear } = searchAll(RULES, many, "blade");
  assert.ok(gear.length <= 5, `expected <= 5 gear, got ${gear.length}`);
});
