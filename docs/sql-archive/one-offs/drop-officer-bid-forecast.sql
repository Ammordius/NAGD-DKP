-- One-shot: drop officer bid-hints / global bid-interest RPCs.
-- Run once in the Supabase SQL editor for the project the site uses.
-- Does not touch bidding-portfolio objects (guild_loot_sale_enriched,
-- bid_forecast_attendees_resolved_for_scope, bid_portfolio_auction_fact, etc.).

DROP FUNCTION IF EXISTS public.officer_global_bid_forecast(integer);
DROP FUNCTION IF EXISTS public.officer_loot_bid_forecast_v2(text, bigint);
DROP FUNCTION IF EXISTS public.officer_loot_bid_forecast(text);
