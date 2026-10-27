/**
 * Public API for the DKP Inquisitor (rule-based roast bot).
 */

export { INTENTS, classifyIntent, normalizeMessage, matchCharacterMention } from './intents.js'
export {
  TEMPLATES,
  TEMPLATE_BY_ID,
  INITIAL_GREETING,
  NO_ACCOUNT_HINT,
  FULL_GEAR_COST_REFUSAL,
  extractPlaceholders,
  fillTemplate,
  KNOWN_PLACEHOLDERS,
} from './templates.js'
export {
  buildAccountFacts,
  normalizePurchase,
  dedupeLootRows,
  lootRowsFromAccountDetail,
  attendanceRowsFromAccountDetail,
  raidsByIdFromAccountDetail,
} from './facts.js'
export {
  buildAccountAttendanceFacts,
  attendanceRoastEligibility,
  responseImpliesCharacterAbsence,
  ATTENDANCE_WINDOW_DAYS,
} from './attendance.js'
export { deriveEvents, THRESHOLDS, classifyBalance, isPriceOutlier, spendingConcentration } from './events.js'
export {
  handleMessage,
  startConversation,
  createConversationState,
  resetIfIdentityChanged,
} from './conversation.js'
export { greetingMessage, buildResponse } from './responseBuilder.js'
export { suggestionChips, matchItemName, formatDkp, buildLinks } from './formatting.js'
export {
  loadClassRankings,
  computeCharacterUpgrades,
  getUpgradesForCharacter,
  findMageloCharacter,
  extractInventory,
  resetUpgradeCaches,
  collectRaidLootItemIds,
} from './upgrades.js'

export const BOT_NAME = 'The DKP Inquisitor'
export const BOT_TAGLINE = 'Your loot history is public. Unfortunately.'
