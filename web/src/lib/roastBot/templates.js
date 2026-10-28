/**
 * Authored response templates for the DKP Inquisitor.
 * Exactly 150 templates with stable IDs A01–J15.
 */

/** @typedef {{ id: string, category: string, requiredFacts: string[], text: string, eligibility?: string }} Template */

/** @type {Template[]} */
export const TEMPLATES = [
  // A. General / Greeting / Default — 15
  { id: 'A01', category: 'general', requiredFacts: [], text: "I've examined your decisions. I would like to speak to whoever authorized them." },
  { id: 'A02', category: 'general', requiredFacts: [], text: 'Welcome back. Unfortunately, your loot history has not improved in your absence.' },
  { id: 'A03', category: 'general', requiredFacts: [], text: 'I can explain DKP. Explaining your behavior is outside my computational capabilities.' },
  { id: 'A04', category: 'general', requiredFacts: [], text: 'There are no stupid questions. There are, however, questions you keep asking.' },
  { id: 'A05', category: 'general', requiredFacts: [], text: 'Your commitment to making questionable decisions is genuinely impressive.' },
  { id: 'A06', category: 'general', requiredFacts: [], text: "I was built to analyze loot. Nobody warned me what I'd find." },
  { id: 'A07', category: 'general', requiredFacts: [], text: 'Some people optimize their characters. Others provide cautionary examples.' },
  { id: 'A08', category: 'general', requiredFacts: [], text: "You're asking a JavaScript switch statement for advice. Somehow, I'm still the responsible one here." },
  { id: 'A09', category: 'general', requiredFacts: [], text: 'I have no artificial intelligence, yet my judgment remains considerably better than yours.' },
  { id: 'A10', category: 'general', requiredFacts: [], text: "I would suggest thinking before bidding, but I don't want to recommend an unfamiliar activity." },
  { id: 'A11', category: 'general', requiredFacts: [], text: "Somewhere, a loot officer is looking at your history and shaking their head." },
  { id: 'A12', category: 'general', requiredFacts: [], text: 'Your next upgrade should probably be your decision-making process.' },
  { id: 'A13', category: 'general', requiredFacts: [], text: 'I admire your confidence. Your evidence, considerably less so.' },
  { id: 'A14', category: 'general', requiredFacts: [], text: 'You have managed to disappoint a collection of conditional statements. Congratulations.' },
  { id: 'A15', category: 'greeting', requiredFacts: [], text: 'Welcome to the DKP Inquisitor. Your dignity was not included in the installation.' },

  // B. DKP Balance — 15
  { id: 'B01', category: 'balance_low', requiredFacts: ['balance'], eligibility: 'balance_low', text: "You're sitting on {balance} DKP. The auctioneer isn't even going to make eye contact." },
  { id: 'B02', category: 'balance_low', requiredFacts: ['balance'], eligibility: 'balance_low', text: "{balance} DKP? That's not a loot budget. That's a participation certificate." },
  { id: 'B03', category: 'balance_low', requiredFacts: ['balance'], eligibility: 'balance_low', text: 'Your current balance is {balance} DKP. Have you considered purchasing something imaginary?' },
  { id: 'B04', category: 'balance_low', requiredFacts: [], eligibility: 'balance_low', text: "I've seen trash mobs drop more financial security than your current DKP situation." },
  { id: 'B05', category: 'balance_low', requiredFacts: ['balance'], eligibility: 'balance_low', text: 'At {balance} DKP, your best bidding strategy is probably enthusiastic moral support.' },
  { id: 'B06', category: 'balance_high', requiredFacts: ['balance'], eligibility: 'balance_high', text: 'You have {balance} DKP. Are you saving it for retirement in the Plane of Tranquility?' },
  { id: 'B07', category: 'balance_high', requiredFacts: [], eligibility: 'balance_high', text: 'Your DKP balance has become a historical preservation project.' },
  { id: 'B08', category: 'balance_high', requiredFacts: ['balance'], eligibility: 'balance_high', text: "{balance} DKP and you're still asking what to buy. The economy has failed you personally." },
  { id: 'B09', category: 'balance_high', requiredFacts: [], eligibility: 'balance_high', text: "At this point you're not saving DKP. You're hoarding imaginary purchasing power." },
  { id: 'B10', category: 'balance_high', requiredFacts: ['balance'], eligibility: 'balance_high', text: 'You have {balance} DKP. Somewhere, an upgrade is begging you to stop treating this like a savings account.' },
  { id: 'B11', category: 'balance_mid', requiredFacts: ['balance'], eligibility: 'balance_mid', text: "With {balance} DKP, you can probably make a reasonable decision. Let's not ruin the suspense." },
  { id: 'B12', category: 'balance_mid', requiredFacts: ['balance'], eligibility: 'balance_mid', text: 'Your balance is {balance} DKP. A respectable number, given the decisions that produced it.' },
  { id: 'B13', category: 'balance_mid', requiredFacts: ['balance'], eligibility: 'balance_mid', text: 'You currently have {balance} DKP. Please use it with slightly more care than last time.' },
  { id: 'B14', category: 'balance_mid', requiredFacts: ['balance'], eligibility: 'balance_mid', text: '{balance} DKP available. I recommend consulting your brain before consulting the auctioneer.' },
  { id: 'B15', category: 'balance_mid', requiredFacts: ['balance'], eligibility: 'balance_mid', text: 'Your DKP balance is {balance}. Whether that represents discipline or indecision remains under investigation.' },

  // C. Purchase History — 15
  { id: 'C01', category: 'biggest_purchase', requiredFacts: ['item', 'cost'], eligibility: 'biggest_purchase', text: 'You spent {cost} DKP on {item}. I assume someone checked whether you were conscious.' },
  { id: 'C02', category: 'biggest_purchase', requiredFacts: ['item', 'cost'], eligibility: 'biggest_purchase', text: "{item} cost you {cost} DKP. That's a lot of confidence for one mouse click." },
  { id: 'C03', category: 'biggest_purchase', requiredFacts: ['item', 'cost'], eligibility: 'biggest_purchase', text: 'Your most expensive recorded purchase was {item} for {cost} DKP. The evidence speaks for itself, unfortunately.' },
  { id: 'C04', category: 'biggest_purchase', requiredFacts: ['item', 'cost'], eligibility: 'biggest_purchase', text: 'You paid {cost} DKP for {item}. I hope the bidding sound was worth it.' },
  { id: 'C05', category: 'biggest_purchase', requiredFacts: ['item', 'cost'], eligibility: 'biggest_purchase', text: 'Remember {item}? Your DKP ledger certainly remembers those {cost} points.' },
  { id: 'C06', category: 'recent_purchase', requiredFacts: ['item', 'cost'], eligibility: 'recent_purchase', text: 'Your recent purchase of {item} for {cost} DKP has been entered into the evidence locker.' },
  { id: 'C07', category: 'recent_purchase', requiredFacts: ['item', 'cost'], eligibility: 'recent_purchase', text: "I see you bought {item} for {cost} DKP. I'm going to assume there was a plan." },
  { id: 'C08', category: 'recent_purchase', requiredFacts: ['item', 'cost'], eligibility: 'recent_purchase', text: 'Another {cost} DKP spent on {item}. Your auction history remains a gripping psychological thriller.' },
  { id: 'C09', category: 'recent_purchase', requiredFacts: ['item'], eligibility: 'recent_purchase', text: "You recently acquired {item}. Congratulations on continuing to support the guild's imaginary economy." },
  { id: 'C10', category: 'recent_purchase', requiredFacts: ['item', 'cost'], eligibility: 'recent_purchase', text: 'That {item} purchase for {cost} DKP was certainly a decision that happened.' },
  { id: 'C11', category: 'purchase_volume', requiredFacts: ['purchaseCount'], eligibility: 'purchase_volume', text: "You've recorded {purchaseCount} loot purchases. At what point does collecting become a medical condition for your inventory?" },
  { id: 'C12', category: 'purchase_volume', requiredFacts: ['purchaseCount'], eligibility: 'purchase_volume', text: "{purchaseCount} purchases and you're still shopping. EverQuest truly has no ending." },
  { id: 'C13', category: 'purchase_volume', requiredFacts: ['purchaseCount'], eligibility: 'purchase_volume', text: "Your history contains {purchaseCount} purchases. I'm beginning to think the auction window is your favorite zone." },
  { id: 'C14', category: 'purchase_volume', requiredFacts: ['purchaseCount'], eligibility: 'purchase_volume', text: "I've reviewed {purchaseCount} loot acquisitions. The impressive part is that you're still looking for more." },
  { id: 'C15', category: 'purchase_volume', requiredFacts: ['purchaseCount'], eligibility: 'purchase_volume', text: '{purchaseCount} recorded purchases. You could have a museum, if any of this were real.' },

  // D. Questionable Purchase Patterns — 15
  { id: 'D01', category: 'slot_repeat', requiredFacts: ['toon', 'slot'], eligibility: 'slot_repeat', text: '{toon} has purchased multiple items for the {slot} slot. Apparently this equipment slot requires a subscription.' },
  { id: 'D02', category: 'slot_repeat', requiredFacts: ['toon', 'slot'], eligibility: 'slot_repeat', text: 'Another {slot} purchase for {toon}? How many times are we planning to solve the same problem?' },
  { id: 'D03', category: 'slot_repeat', requiredFacts: ['slot'], eligibility: 'slot_repeat', text: 'Your {slot} shopping history suggests a deeply personal relationship with replacement equipment.' },
  { id: 'D04', category: 'slot_repeat', requiredFacts: ['toon', 'slot'], eligibility: 'slot_repeat', text: 'I see a pattern of {slot} purchases on {toon}. I hope the previous ones received proper retirement ceremonies.' },
  { id: 'D05', category: 'slot_repeat', requiredFacts: ['toon', 'slot'], eligibility: 'slot_repeat', text: 'Multiple {slot} purchases for {toon}. The inventory management alone deserves its own raid.' },
  { id: 'D06', category: 'price_outlier', requiredFacts: ['item', 'cost', 'medianPrice'], eligibility: 'price_outlier', text: 'You paid {cost} DKP for {item}. Comparable sales had a median of {medianPrice}. Fascinating negotiation skills.' },
  { id: 'D07', category: 'price_outlier', requiredFacts: ['item', 'cost', 'medianPrice'], eligibility: 'price_outlier', text: '{item} cost you {cost} DKP, against a comparable median of {medianPrice}. The auctioneer must love you.' },
  { id: 'D08', category: 'price_outlier', requiredFacts: ['item', 'cost', 'medianPrice'], eligibility: 'price_outlier', text: 'That {cost} DKP purchase of {item} sits above the comparable {medianPrice} median. You certainly helped establish a price ceiling.' },
  { id: 'D09', category: 'price_outlier', requiredFacts: ['cost', 'medianPrice'], eligibility: 'price_outlier', text: 'You paid {cost} DKP for something with a comparable sale median of {medianPrice}. Generosity is apparently your build strategy.' },
  { id: 'D10', category: 'price_outlier', requiredFacts: ['item', 'cost', 'medianPrice'], eligibility: 'price_outlier', text: '{item}: {cost} DKP paid, {medianPrice} comparable median. Have you considered bidding with slightly less enthusiasm?' },
  { id: 'D11', category: 'purchase_unknown_value', requiredFacts: ['item', 'cost'], eligibility: 'purchase_unknown_value', text: 'You spent {cost} DKP on {item}. Whether it was brilliant or terrible remains an unsolved crime.' },
  { id: 'D12', category: 'purchase_unknown_value', requiredFacts: ['item', 'cost'], eligibility: 'purchase_unknown_value', text: 'I can verify that {item} cost you {cost} DKP. I cannot verify that this was wise.' },
  { id: 'D13', category: 'purchase_unknown_value', requiredFacts: ['item', 'cost'], eligibility: 'purchase_unknown_value', text: '{item} for {cost} DKP. The transaction is documented. The reasoning is mysteriously absent.' },
  { id: 'D14', category: 'purchase_unknown_value', requiredFacts: ['item'], eligibility: 'purchase_unknown_value', text: 'I found your {item} purchase. Unfortunately, the data offers no explanation for your enthusiasm.' },
  { id: 'D15', category: 'purchase_unknown_value', requiredFacts: ['item', 'cost'], eligibility: 'purchase_unknown_value', text: "You paid {cost} DKP for {item}. I'll reserve judgment until your gear data catches up. Reluctantly." },

  // E. Multiple Characters — 15
  { id: 'E01', category: 'multi_char', requiredFacts: ['charCount'], eligibility: 'multi_char', text: "You have {charCount} characters. Apparently one unfinished gearing project wasn't enough." },
  { id: 'E02', category: 'multi_char', requiredFacts: [], eligibility: 'multi_char', text: 'Your DKP spending is spread across multiple characters. Diversification is a bold word for this.' },
  { id: 'E03', category: 'multi_char', requiredFacts: ['charCount'], eligibility: 'multi_char', text: "With {charCount} characters, I'm beginning to suspect your actual main is the character-select screen." },
  { id: 'E04', category: 'multi_char', requiredFacts: ['charCount'], eligibility: 'multi_char', text: "You have {charCount} characters and you're asking which one needs gear. Yes. That's the problem." },
  { id: 'E05', category: 'multi_char', requiredFacts: [], eligibility: 'multi_char', text: 'Your equipment budget is supporting an entire cast of characters. None of them seem interested in financial restraint.' },
  { id: 'E06', category: 'spend_concentration', requiredFacts: ['toon', 'sharePct'], eligibility: 'spend_concentration', text: '{toon} accounts for {sharePct}% of your attributable character spending. That\'s a considerable amount of affection.' },
  { id: 'E07', category: 'spend_concentration', requiredFacts: ['toon', 'sharePct'], eligibility: 'spend_concentration', text: "You've directed {sharePct}% of your recorded character spending toward {toon}. I hope it sends thank-you cards." },
  { id: 'E08', category: 'spend_concentration', requiredFacts: ['toon'], eligibility: 'spend_concentration', text: "{toon} has received quite the investment. Your other characters must be thrilled." },
  { id: 'E09', category: 'spend_concentration', requiredFacts: ['toon'], eligibility: 'spend_concentration', text: "You've spent enough on {toon} that I'm wondering whether you even have a favorite character anymore." },
  { id: 'E10', category: 'spend_concentration', requiredFacts: ['toon'], eligibility: 'spend_concentration', text: '{toon} is enjoying a very generous share of your loot budget. Apparently moderation is for other guilds.' },
  { id: 'E11', category: 'two_chars', requiredFacts: ['toon', 'otherToon'], eligibility: 'two_chars', text: 'Between {toon} and {otherToon}, I can see why your DKP disappears so quickly.' },
  { id: 'E12', category: 'two_chars', requiredFacts: ['toon', 'otherToon'], eligibility: 'two_chars', text: "You own both {toon} and {otherToon}. Your problem isn't a lack of characters. It's an excess of ambition." },
  { id: 'E13', category: 'two_chars', requiredFacts: ['toon', 'otherToon'], eligibility: 'two_chars', text: 'Every time you ask about {toon}, I imagine {otherToon} preparing another shopping list.' },
  { id: 'E14', category: 'two_chars', requiredFacts: ['toon', 'otherToon'], eligibility: 'two_chars', text: '{toon} needs gear. {otherToon} probably does too. Your wallet has filed a formal complaint.' },
  { id: 'E15', category: 'two_chars', requiredFacts: [], eligibility: 'two_chars', text: 'I was going to recommend focusing on one character, but your account history suggests you dislike commitment.' },

  // F. Gear Upgrades — 15
  { id: 'F01', category: 'upgrade_strong', requiredFacts: ['item', 'upgrade', 'toon'], eligibility: 'upgrade_strong', text: "{item} would provide {upgrade} for {toon}. That's genuinely good. Please don't make me say it twice." },
  { id: 'F02', category: 'upgrade_strong', requiredFacts: ['item', 'upgrade', 'toon'], eligibility: 'upgrade_strong', text: 'For {toon}, {item} is a strong upgrade: {upgrade}. Even you might have trouble ruining this one.' },
  { id: 'F03', category: 'upgrade_strong', requiredFacts: ['item', 'upgrade'], eligibility: 'upgrade_strong', text: 'I found an actual improvement: {item}, providing {upgrade}. Alert the guild. Something sensible has happened.' },
  { id: 'F04', category: 'upgrade_strong', requiredFacts: ['item', 'toon'], eligibility: 'upgrade_strong', text: "{toon} could benefit substantially from {item}. I checked the math twice because I assumed you'd picked something worse." },
  { id: 'F05', category: 'upgrade_strong', requiredFacts: ['item', 'upgrade', 'toon'], eligibility: 'upgrade_strong', text: '{item} looks excellent for {toon}: {upgrade}. I regret being forced to approve of your interests.' },
  { id: 'F06', category: 'upgrade_modest', requiredFacts: ['item', 'upgrade', 'toon'], eligibility: 'upgrade_modest', text: '{item} is an upgrade for {toon}, technically. {upgrade}. Try to contain your excitement.' },
  { id: 'F07', category: 'upgrade_modest', requiredFacts: ['item', 'toon'], eligibility: 'upgrade_modest', text: 'You could upgrade {toon} with {item}. The improvement is modest, much like my expectations.' },
  { id: 'F08', category: 'upgrade_modest', requiredFacts: ['item', 'upgrade'], eligibility: 'upgrade_modest', text: '{item} offers {upgrade}. Not life-changing, but neither was your last brilliant shopping expedition.' },
  { id: 'F09', category: 'upgrade_modest', requiredFacts: ['item', 'toon'], eligibility: 'upgrade_modest', text: "I found a small improvement for {toon}: {item}. Whether it's worth chasing is another question." },
  { id: 'F10', category: 'upgrade_modest', requiredFacts: ['item', 'upgrade', 'toon'], eligibility: 'upgrade_modest', text: '{item} improves {toon} by {upgrade}. Small progress is still progress, I suppose.' },
  { id: 'F11', category: 'upgrade_any', requiredFacts: ['item', 'slot'], eligibility: 'upgrade_any', text: "Good news: {item} improves your {slot} situation. Bad news: you'll probably ask about twelve alternatives." },
  { id: 'F12', category: 'upgrade_any', requiredFacts: ['item', 'toon'], eligibility: 'upgrade_any', text: '{toon} has a legitimate upgrade candidate in {item}. I recommend pursuing it before you discover something worse.' },
  { id: 'F13', category: 'upgrade_any', requiredFacts: ['item', 'slot'], eligibility: 'upgrade_any', text: 'Your {slot} slot can benefit from {item}. Apparently your character still has room for better decisions.' },
  { id: 'F14', category: 'upgrade_any', requiredFacts: ['item', 'toon'], eligibility: 'upgrade_any', text: 'The gear calculations favor {item} for {toon}. This is an unusually defensible choice for you.' },
  { id: 'F15', category: 'upgrade_any', requiredFacts: ['item', 'toon'], eligibility: 'upgrade_any', text: "{item} is worth considering for {toon}. That's advice, not permission to bid your entire balance." },

  // G. Affordability — 15
  { id: 'G01', category: 'afford_yes', requiredFacts: ['item', 'lastSale'], eligibility: 'afford_yes', text: "{item} last sold for {lastSale} DKP. You could cover that historical price. Your judgment is a separate expense." },
  { id: 'G02', category: 'afford_yes', requiredFacts: ['item', 'lastSale'], eligibility: 'afford_yes', text: 'At the last recorded price of {lastSale} DKP, {item} is within your current balance. Please try not to make this embarrassing.' },
  { id: 'G03', category: 'afford_yes', requiredFacts: ['item', 'lastSale'], eligibility: 'afford_yes', text: "You have enough DKP to match {item}'s last recorded sale of {lastSale}. That is not a recommendation to start a bidding war." },
  { id: 'G04', category: 'afford_yes', requiredFacts: ['item', 'lastSale'], eligibility: 'afford_yes', text: "{item} last went for {lastSale} DKP. Your balance can handle that reference point, assuming you can handle arithmetic." },
  { id: 'G05', category: 'afford_yes', requiredFacts: ['item', 'lastSale'], eligibility: 'afford_yes', text: "Yes, {item} is affordable relative to its last {lastSale} DKP sale. I'm much less confident about your self-control." },
  { id: 'G06', category: 'afford_no', requiredFacts: ['item', 'lastSale'], eligibility: 'afford_no', text: "{item} last sold for {lastSale} DKP. Your balance isn't there yet. Dreaming remains free." },
  { id: 'G07', category: 'afford_no', requiredFacts: ['item', 'lastSale'], eligibility: 'afford_no', text: 'At its last recorded {lastSale} DKP price, {item} is beyond your current balance. Ambition costs nothing, fortunately.' },
  { id: 'G08', category: 'afford_no', requiredFacts: ['item', 'lastSale'], eligibility: 'afford_no', text: 'You want {item}, which last sold for {lastSale} DKP. Your DKP balance has declined to comment.' },
  { id: 'G09', category: 'afford_no', requiredFacts: ['item', 'lastSale'], eligibility: 'afford_no', text: "{item} last went for {lastSale} DKP. You're short of that reference price. Perhaps consider earning DKP before spending it." },
  { id: 'G10', category: 'afford_no', requiredFacts: ['item', 'lastSale'], eligibility: 'afford_no', text: 'The last recorded price for {item} was {lastSale} DKP. Your current balance is not particularly enthusiastic.' },
  { id: 'G11', category: 'afford_unknown', requiredFacts: ['item'], eligibility: 'afford_unknown', text: "I can't find a reliable recorded price for {item}. I assume you'll bid recklessly anyway." },
  { id: 'G12', category: 'afford_unknown', requiredFacts: ['item'], eligibility: 'afford_unknown', text: 'No usable DKP sale history for {item}. Your opportunity to establish a terrible precedent awaits.' },
  { id: 'G13', category: 'afford_unknown', requiredFacts: ['item'], eligibility: 'afford_unknown', text: "There's no reliable historical price for {item}. Even I refuse to invent numbers just to insult you." },
  { id: 'G14', category: 'afford_unknown', requiredFacts: ['item'], eligibility: 'afford_unknown', text: "I can't tell you what {item} will cost. Perhaps the auctioneer can introduce you to the concept of uncertainty." },
  { id: 'G15', category: 'afford_unknown', requiredFacts: ['item'], eligibility: 'afford_unknown', text: "No trustworthy price data for {item}. I suppose you'll have to discover your financial limits organically." },

  // H. Account-level attendance — 15 (NEVER character-specific absence)
  { id: 'H01', category: 'attendance_frequent', requiredFacts: ['raidCount'], eligibility: 'attendance_frequent', text: 'Your account has appeared in {raidCount} recorded raids. Persistence is clearly not your problem. Judgment may be.' },
  { id: 'H02', category: 'attendance_frequent', requiredFacts: ['raidCount'], eligibility: 'attendance_frequent', text: "{raidCount} raids on record for your account. It's remarkable how much raiding still hasn't cured your shopping habits." },
  { id: 'H03', category: 'attendance_frequent', requiredFacts: ['raidCount'], eligibility: 'attendance_frequent', text: "You've shown up for {raidCount} recorded raids. All that experience, and these are still your purchase decisions." },
  { id: 'H04', category: 'attendance_frequent', requiredFacts: [], eligibility: 'attendance_frequent', text: "Your account's raid participation is strong. I'm running out of excuses for your DKP behavior." },
  { id: 'H05', category: 'attendance_frequent', requiredFacts: [], eligibility: 'attendance_frequent', text: 'At least your account attends raids. Now we just need to work on what happens at the auction.' },
  { id: 'H06', category: 'attendance_sparse', requiredFacts: ['daysSince'], eligibility: 'attendance_sparse', text: "It's been {daysSince} days since your account's last recorded raid. Your DKP doesn't earn interest while you're away." },
  { id: 'H07', category: 'attendance_sparse', requiredFacts: ['daysSince'], eligibility: 'attendance_sparse', text: 'Your account has been quiet for {daysSince} days. Did you forget the raid schedule, or are you protecting your wallet?' },
  { id: 'H08', category: 'attendance_sparse', requiredFacts: ['lastRaid'], eligibility: 'attendance_sparse', text: 'The last recorded raid for your account was {lastRaid}. Your auction history seems more active than your schedule.' },
  { id: 'H09', category: 'attendance_sparse', requiredFacts: ['raidCount'], eligibility: 'attendance_sparse', text: 'Your account has recorded {raidCount} raids in the comparison period. Apparently the hardest encounter is the calendar.' },
  { id: 'H10', category: 'attendance_sparse', requiredFacts: [], eligibility: 'attendance_sparse', text: 'Your recent account attendance has been sparse. The loot table will attempt to recover from the disappointment.' },
  { id: 'H11', category: 'attendance_return', requiredFacts: [], eligibility: 'attendance_return', text: 'Your account is back raiding. Wonderful. The DKP economy was getting dangerously sensible.' },
  { id: 'H12', category: 'attendance_return', requiredFacts: ['daysSince'], eligibility: 'attendance_return', text: 'You returned after {daysSince} days away between recorded raids. I assume your bidding finger needed rehabilitation.' },
  { id: 'H13', category: 'attendance_return', requiredFacts: [], eligibility: 'attendance_return', text: 'Welcome back to the raid schedule. We had almost recovered from your shopping habits.' },
  { id: 'H14', category: 'attendance_return', requiredFacts: [], eligibility: 'attendance_return', text: 'Your account recently resumed raiding. Please try to spend the resulting DKP responsibly. I know that\'s a lot to ask.' },
  { id: 'H15', category: 'attendance_return', requiredFacts: [], eligibility: 'attendance_return', text: 'You made it back to raids. Congratulations on rediscovering the part of EverQuest that funds your bad decisions.' },

  // I. Item search / drops / sales — 15
  { id: 'I01', category: 'item_source', requiredFacts: ['item', 'mob', 'zone'], eligibility: 'item_source', text: '{item} drops from {mob} in {zone}. Unfortunately, showing up there requires slightly more effort than asking me.' },
  { id: 'I02', category: 'item_source', requiredFacts: ['item', 'mob'], eligibility: 'item_source', text: "You'll find {item} from {mob}. Try killing it before planning how much DKP to waste." },
  { id: 'I03', category: 'item_source', requiredFacts: ['item', 'mob', 'zone'], eligibility: 'item_source', text: 'The recorded source for {item} is {mob} in {zone}. Geography: another challenge successfully solved for you.' },
  { id: 'I04', category: 'item_source', requiredFacts: ['item', 'mob', 'zone'], eligibility: 'item_source', text: '{mob} in {zone} is a source of {item}. I hope your raid preparation exceeds your purchasing discipline.' },
  { id: 'I05', category: 'item_source', requiredFacts: ['item', 'zone'], eligibility: 'item_source', text: "Looking for {item}? Try {zone}. You're welcome for this astonishing feat of research." },
  { id: 'I06', category: 'item_sale', requiredFacts: ['item', 'lastSale'], eligibility: 'item_sale', text: "{item} last sold for {lastSale} DKP. That's historical data, not permission to double it." },
  { id: 'I07', category: 'item_sale', requiredFacts: ['item', 'lastSale'], eligibility: 'item_sale', text: 'The latest recorded sale of {item} was {lastSale} DKP. Please absorb this information without immediately bidding.' },
  { id: 'I08', category: 'item_sale', requiredFacts: ['item', 'lastSale'], eligibility: 'item_sale', text: "I've found a {lastSale} DKP recorded sale for {item}. You seem exactly like the kind of person who would ignore that context." },
  { id: 'I09', category: 'item_sale', requiredFacts: ['item', 'lastSale'], eligibility: 'item_sale', text: "{item}: last recorded price {lastSale} DKP. You're welcome for doing your homework." },
  { id: 'I10', category: 'item_sale', requiredFacts: ['item', 'lastSale'], eligibility: 'item_sale', text: "The history says {lastSale} DKP for {item}'s latest recorded sale. The future auctioneer owes you no favors." },
  { id: 'I11', category: 'item_unmatched', requiredFacts: ['item'], eligibility: 'item_unmatched', text: "I can't identify {item} in the available item data. Have you considered spelling as a raid skill?" },
  { id: 'I12', category: 'item_unmatched', requiredFacts: ['item'], eligibility: 'item_unmatched', text: "{item} isn't a reliable match in my records. Inventing loot would be irresponsible, even by your standards." },
  { id: 'I13', category: 'item_unmatched', requiredFacts: ['item'], eligibility: 'item_unmatched', text: 'I searched for {item}. The database is as confused as I am.' },
  { id: 'I14', category: 'item_unmatched', requiredFacts: ['item'], eligibility: 'item_unmatched', text: 'No trustworthy item match for {item}. I suggest looking at the actual item name before opening your wallet.' },
  { id: 'I15', category: 'item_unmatched', requiredFacts: ['item'], eligibility: 'item_unmatched', text: "I don't have enough information to identify {item}. Somehow this conversation has made both of us less informed." },

  // J. Follow-ups / defenses / misc — 15
  { id: 'J01', category: 'defense', requiredFacts: [], eligibility: 'defense', text: "I'm sure you had a perfectly good reason. I'm equally sure it sounded better in your head." },
  { id: 'J02', category: 'defense', requiredFacts: [], eligibility: 'defense', text: 'That\'s an interesting defense. Unfortunately, the DKP ledger does not recognize emotional arguments.' },
  { id: 'J03', category: 'defense', requiredFacts: [], eligibility: 'defense', text: 'You can explain the purchase all you like. The transaction remains committed.' },
  { id: 'J04', category: 'defense', requiredFacts: [], eligibility: 'defense', text: "I'm not saying your decision was wrong. I'm saying the available evidence is struggling to defend it." },
  { id: 'J05', category: 'defense', requiredFacts: [], eligibility: 'defense', text: 'Every questionable bid has a compelling backstory, usually narrated by the person who placed it.' },
  { id: 'J06', category: 'followup_item', requiredFacts: ['item'], eligibility: 'followup_item', text: 'Still discussing {item}? This purchase has received more analysis than most guild strategies.' },
  { id: 'J07', category: 'followup_item', requiredFacts: ['item'], eligibility: 'followup_item', text: "Back to {item}, are we? I'm beginning to understand how you ended up buying it." },
  { id: 'J08', category: 'followup_item', requiredFacts: ['item'], eligibility: 'followup_item', text: 'You seem unusually invested in {item}. I hope the equipment returns that affection.' },
  { id: 'J09', category: 'followup_item', requiredFacts: ['item'], eligibility: 'followup_item', text: 'Yes, I remember {item}. Unlike your apparent spending discipline, my conversation state works.' },
  { id: 'J10', category: 'followup_item', requiredFacts: ['item'], eligibility: 'followup_item', text: 'Another question about {item}. At this point it should probably pay rent.' },
  { id: 'J11', category: 'unknown', requiredFacts: [], eligibility: 'unknown', text: 'I have no idea what you\'re asking, which is a refreshing change from knowing exactly how bad the answer will be.' },
  { id: 'J12', category: 'unknown', requiredFacts: [], eligibility: 'unknown', text: 'Try asking about loot, upgrades, DKP, or your terrible decisions. I specialize in the last one.' },
  { id: 'J13', category: 'unknown', requiredFacts: [], eligibility: 'unknown', text: 'That question is outside my expertise. Unfortunately, so is your apparent strategy.' },
  { id: 'J14', category: 'unknown', requiredFacts: [], eligibility: 'unknown', text: 'I am a collection of deterministic rules, not a miracle worker. Try a clearer question.' },
  { id: 'J15', category: 'unknown', requiredFacts: [], eligibility: 'unknown', text: 'I could pretend to understand, but unlike your bidding history, I have standards.' },
]

export const TEMPLATE_BY_ID = Object.fromEntries(TEMPLATES.map((t) => [t.id, t]))

export const INITIAL_GREETING =
  "Welcome to the DKP Inquisitor. I've reviewed your loot history, and I'm disappointed already."

export const NO_ACCOUNT_HINT =
  'Personalized insults require a claimed game account. Link one on Game Accounts, then return for a properly tailored disappointment.'

export const FULL_GEAR_COST_REFUSAL =
  'There is no reliable fixed DKP total for finishing every upgrade. Future bids and drops are uncertain, and I refuse to invent a budget just so you can ignore it. Ask about individual items if you want historical sale prices.'

/** Placeholder names supported in templates. */
export const KNOWN_PLACEHOLDERS = [
  'account',
  'toon',
  'otherToon',
  'item',
  'cost',
  'balance',
  'slot',
  'upgrade',
  'zone',
  'mob',
  'lastSale',
  'medianPrice',
  'purchaseCount',
  'charCount',
  'sharePct',
  'raidCount',
  'daysSince',
  'lastRaid',
]

/**
 * @param {string} text
 * @returns {string[]}
 */
export function extractPlaceholders(text) {
  const found = []
  const re = /\{([a-zA-Z]+)\}/g
  let m
  while ((m = re.exec(text))) {
    if (!found.includes(m[1])) found.push(m[1])
  }
  return found
}

/**
 * Substitute placeholders. Missing required values return null (caller must pick another template).
 * @param {string} text
 * @param {Record<string, string|number|null|undefined>} values
 */
export function fillTemplate(text, values) {
  const needed = extractPlaceholders(text)
  for (const key of needed) {
    const v = values[key]
    if (v == null || v === '') return null
  }
  return text.replace(/\{([a-zA-Z]+)\}/g, (_, key) => String(values[key]))
}
