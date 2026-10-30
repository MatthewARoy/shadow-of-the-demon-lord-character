// Per-deployment settings. This committed copy is the GitHub Pages build:
// spell relabel reports go to the public repo and party sync stays off.
// scripts/cf/stage.mjs overwrites this file in the Cloudflare build so that
// copy names no GitHub account and turns sync on (see
// docs/superpowers/specs/2026-10-29-shared-party-storage-design.md).
export const SITE = {
  issueRepo: "MatthewARoy/shadow-of-the-demon-lord-character",
  syncEnabled: false,
};
