/**
 * Public API for the Paperclip resource router (redirect-only, intent-aware).
 */

export {
  BOT_NAME,
  BOT_TAGLINE,
  KIND,
  DOMAIN,
  RESOURCES,
  GOOGLE_DOCS,
  GUILDTAG_FORUMS,
  withGuildtagUrls,
  getResourceById,
} from './catalog.js'

export {
  ENTITIES,
  FLAG_MOB_NAMES,
  DOMAIN_CUES,
  detectDomainCues,
  detectEntities,
  detectFlagMobMention,
  resolveEntitySenses,
  isCapabilitiesQuery,
} from './entities.js'

export {
  normalizeQuery,
  kindPhrase,
  formatRedirect,
  formatDisambiguation,
  scoreResource,
  matchResources,
  buildRedirectReply,
  greetingMessage,
  POTIME_BUNDLE_IDS,
} from './match.js'
