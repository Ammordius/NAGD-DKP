/**
 * Public API for the DKP Inquisitor (rule-based roast bot).
 */

export { INTENTS, classifyIntent, normalizeMessage, matchCharacterMention, CHARACTER_SCOPED_INTENTS } from './intents.js'
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
  scopedPurchaseFacts,
  purchaseMatchesCharacter,
  pickSpendPurchase,
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
  selectCharacterId,
} from './conversation.js'
export { greetingMessage, buildResponse, renderAnswer } from './responseBuilder.js'
export { suggestionChips, matchItemName, formatDkp, buildLinks } from './formatting.js'
export {
  DEFAULT_CLASS_RANKINGS_URL,
  loadClassRankings,
  validateClassRankingsSchema,
  formatMageloLoadError,
  computeCharacterUpgrades,
  getUpgradesForCharacter,
  findMageloCharacter,
  extractInventory,
  resetUpgradeCaches,
  collectRaidLootItemIds,
} from './upgrades.js'
export { assessCharacterGear } from './gearAssessment.js'
export { dispatchHandler } from './handlers/index.js'
export { isEligible, categoriesForIntent } from './rules.js'

export const BOT_NAME = 'The DKP Inquisitor'
export const BOT_TAGLINE = 'Your loot history is public. Unfortunately.'
