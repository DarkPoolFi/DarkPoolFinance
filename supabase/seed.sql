-- Chainlink tokenized-equity feeds on Robinhood Chain mainnet (4663), 8 decimals, 24h heartbeat, 0.5% deviation.
-- Source: https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json (docs.chain.link/data-feeds/tokenized-equity-feeds/robinhood)
-- ETH/USD feed: DARKPOOL_ETH_USD_FEED. Names, token addresses and multipliers come from the asset registry sync (assets.ts).
-- Everything inactive except the launch set at the bottom.
insert into dark_assets (symbol, name, feed_address, active) values
  ('AAPL', 'AAPL', '0x6b22a786baa607d76728168703a39ea9c99f2cd0', false),
  ('AMD', 'AMD', '0x943a29e7ae51a4798823ca9eed2ed533b2a22c72', false),
  ('AMZN', 'AMZN', '0xd5a1508ced74c084ebf3cbe853e2c968fb2a651c', false),
  ('ASML', 'ASML', '0xb4106147e8cce40b7d46124090d373a71b70f87d', false),
  ('BABA', 'BABA', '0x62cc8f9b5f56a33c9c8a60c8b92779f523c4e984', false),
  ('CLSK', 'CLSK', '0x810c12d3a554bc47fd39597fe3b3aac4941f50ef', false),
  ('COIN', 'COIN', '0xa3a468a452940b7d6b69991207b508c609a98ef2', false),
  ('CRCL', 'CRCL', '0x6652edf64ba3731c4f2d3ce821a0fb1f1f6b482a', false),
  ('CRWV', 'CRWV', '0xe1b3aabcafad1c94708dc1367dcff8aa4407487c', false),
  ('DELL', 'DELL', '0x1c6c8cadbe02e19129c39ddb92281ce4c0bf206b', false),
  ('EWY', 'EWY', '0xefdf54610b62a7753ec30bdc380847c12d32e1d1', false),
  ('GME', 'GME', '0x27c71df6a64fb476468edf256cf72c038bab5b67', false),
  ('GOOGL', 'GOOGL', '0xf6f373a037c30f0e5010d854385ca89185ae638b', false),
  ('INTC', 'INTC', '0x3f390c5c24628ac7c489515402235fead71d1913', false),
  ('IONQ', 'IONQ', '0x22efec4919baf55f360e0edee4abeb26de4971eb', false),
  ('META', 'META', '0x7c38c00c30bee9378381e7b6135d7283356d71b1', false),
  ('MSFT', 'MSFT', '0x45c3c877c15e6ba2ebb19ea114ea508d14c1af2e', false),
  ('MSTR', 'MSTR', '0x396118bdfb181e6240e74d243f266b061c0edc3d', false),
  ('MU', 'MU', '0x425eefdcf05ed6526c3ce61af99429a228a6d596', false),
  ('NBIS', 'NBIS', '0xe1d87b116ba0fe898998f1d140339d1fa1e09705', false),
  ('NVDA', 'NVDA', '0x379ec4f7c378f34a1b47e4f3cbebcbac3e8e9f15', false),
  ('ORCL', 'ORCL', '0x0e6a64a2b58a6693a531e6c555f3a5d042eea844', false),
  ('PLTR', 'PLTR', '0x820abedff239034956b7a9d2f0a331f9f075eb4c', false),
  ('QQQ', 'QQQ', '0x80901d846d5d7b030f26b480776ee3b29374c2ae', false),
  ('RGTI', 'RGTI', '0x2a045cf1c49c61c166c036d2f06fa2d2d984f765', false),
  ('RKLB', 'RKLB', '0x045477bf65aef6f4f2386ad0164579e48381cc74', false),
  ('SGOV', 'SGOV', '0xa0df4ee0fff975306345875e3548fcc519577a11', false),
  ('SLV', 'SLV', '0x209b73908e92ae021826ed79609845451ecba2ce', false),
  ('SNDK', 'SNDK', '0xfb133fa4b7b385802b693a293606682df47109a3', false),
  ('SPCX', 'SPCX', '0xb265810950ba6c5c0ff821c9963014a56fd8bffb', false),
  ('SPY', 'SPY', '0x319724394d3a0e3669269846abe664cd621f9f6a', false),
  ('TSLA', 'TSLA', '0x4a1166a659a55625345e9515b32adecea5547c38', false),
  ('TSM', 'TSM', '0x874cf94aa8ec88fd9560094dd065f2fb3e41fc2f', false),
  ('USAR', 'USAR', '0xa994d3684e8400a6c8078226925779fdee682dd9', false),
  ('USO', 'USO', '0x75a9c76ef439e2c7c2e5a34ab105ecfe3766431c', false)
on conflict (symbol) do update set feed_address = excluded.feed_address;

-- Launch assets: the most widely held US stocks.
update dark_assets set launch = true, active = true where symbol in ('AAPL', 'NVDA', 'TSLA', 'AMZN', 'MSFT');
