/**
 * Build-time feature gate for experimental entertainment features
 * (DKP Inquisitor / RoastBot and Quarm's Questionable Expedition).
 *
 * Only an exact case-insensitive match of the trimmed string "true" enables
 * Fun Zone. Unset, empty, "false", "0", and any other value are disabled.
 * Do not use JavaScript truthiness — Boolean("false") is true.
 */
export function isFunZoneEnabled(
  value = import.meta.env?.VITE_FUNZONE_ENABLED
) {
  return typeof value === 'string'
    && value.trim().toLowerCase() === 'true'
}
