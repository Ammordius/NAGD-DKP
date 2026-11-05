/**
 * Golden discovery eval case schema (structured expectations, not exact NL strings).
 */

/**
 * @typedef {'A_raid_boss_zone'|'B_items_slots'|'C_paraphrase'|'D_context'|'E_malformed'|'F_isolation'|'seed'} EvalCategory
 *
 * @typedef {'answered'|'clarification'|'no_match'|'unsupported'|'not_discovery'|'error'} OutcomeClass
 *
 * @typedef {object} EvalExpect
 * @property {import('../types.js').RecognitionStatus} [recognitionStatus]
 * @property {string} [intent]
 * @property {string} [family]
 * @property {string} [scope]
 * @property {string|null} [boss]
 * @property {string|null} [zone]
 * @property {string|null} [phase]
 * @property {string|null} [slot]
 * @property {string|null} [character]
 * @property {RegExp|string|null} [itemQueryMatch]
 * @property {RegExp|string|null} [resolvedItemMatch]
 * @property {string|null} [resolvedItemId]
 * @property {string[]} [awardIds]
 * @property {string[]} [awardRecipients]
 * @property {OutcomeClass} [outcome]
 * @property {boolean} [mustChangeEntity]
 * @property {string} [prevItemMustNotAppear]
 * @property {boolean} [skipRetrieval]
 *
 * @typedef {object} EvalCase
 * @property {string} id
 * @property {EvalCategory} category
 * @property {string} text
 * @property {string} [prevText]
 * @property {EvalCase[]} [turns] - multi-turn sequence (overrides text when present)
 * @property {EvalExpect} expect
 * @property {EvalExpect[]} [expectTurns]
 * @property {string} [group] - metamorphic equivalence group id
 * @property {boolean} [inScope]
 */

/**
 * @param {Partial<EvalCase> & { id: string, category: EvalCategory, text?: string }} partial
 * @returns {EvalCase}
 */
export function defineCase(partial) {
  return {
    inScope: true,
    expect: {},
    ...partial,
    text: partial.text || partial.turns?.[0] || '',
  }
}
