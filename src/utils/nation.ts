/**
 * Country / nation names are stored canonically as `name.trim().toLowerCase()`
 * so that palette[name], owners.includes(name), and force.nation === entry.nation
 * never miss because of case drift. Display sites uppercase via CSS
 * (text-transform: uppercase) so the underlying value stays canonical.
 *
 * Apply this at every mutation entry point — reducer, perm.json reads,
 * snapshot imports — so normalization is a one-way contract: anything
 * inside AppState is already lowercase.
 */
export function normalizeNation(name: string): string {
  return name.trim().toLowerCase();
}
