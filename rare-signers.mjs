// Rare signers: big names who seldom do public autograph signings. Their /autographs/<slug>/ pages
// get a hand-written block (signing status, how to get the autograph now, FAQ with FAQPage JSON-LD)
// and stay indexed and in the sitemap even with no signings listed, so fans searching
// "<name> autograph signing" find the page and sign up for an alert.
// Trusted hand-written text (no esc()). Keep claims general: no dates or deal names we can't stand behind.
// pattern: 'occasional' = does public or private signings now and then; 'rare' = almost never signs in public.
// Tracked in the "Rare signers" tab of the SEO keyword sheet.
export const RARE_SIGNERS = [
  { name: 'Barry Sanders', sport: 'Football', pattern: 'occasional', known: 'the Detroit Lions Hall of Fame running back who retired at the top of his game', tip: 'Lions-themed card shows and Michigan-area promoters are the most likely places for him to turn up.' },
  { name: 'Tom Brady', sport: 'Football', pattern: 'rare', known: 'the seven-time Super Bowl champion quarterback', tip: 'Nearly all certified Brady autographs come through exclusive memorabilia deals, so expect a high price whenever a private signing opens.' },
  { name: 'Peyton Manning', sport: 'Football', pattern: 'rare', known: 'the Colts and Broncos Hall of Fame quarterback', tip: 'Manning signs mostly through private signings run by memorabilia companies; mail-in slots tend to sell out fast.' },
  { name: 'John Elway', sport: 'Football', pattern: 'occasional', known: 'the Denver Broncos Hall of Fame quarterback', tip: 'Denver-area shows and Broncos-focused promoters are the first places to watch.' },
  { name: 'Joe Montana', sport: 'Football', pattern: 'occasional', known: 'the four-time Super Bowl champion 49ers quarterback', tip: 'Montana has done paid private and in-person signings over the years, often at the higher end of the price range.' },
  { name: 'Patrick Mahomes', sport: 'Football', pattern: 'rare', known: 'the Kansas City Chiefs quarterback', tip: 'As an active star, Mahomes signs mostly for exclusive memorabilia and card deals rather than public events.' },
  { name: 'Shohei Ohtani', sport: 'Baseball', pattern: 'rare', known: 'the two-way Dodgers superstar', tip: 'Public Ohtani signings are almost unheard of; most authentic autographs come from certified card inserts and licensed memorabilia.' },
  { name: 'Mike Trout', sport: 'Baseball', pattern: 'rare', known: 'the Los Angeles Angels center fielder', tip: 'Trout autographs mostly come from licensed memorabilia and card releases; public appearances are rare during the season.' },
  { name: 'Derek Jeter', sport: 'Baseball', pattern: 'rare', known: 'the New York Yankees Hall of Fame shortstop', tip: 'Jeter signs mainly through exclusive and private signings, so certified memorabilia is the usual route.' },
  { name: 'Ichiro Suzuki', sport: 'Baseball', pattern: 'rare', known: 'the Seattle Mariners Hall of Famer and 3,000-hit legend', tip: 'Ichiro has long been one of the hardest autographs in baseball to get in person; certified cards and memorabilia are the realistic options.' },
  { name: 'Sandy Koufax', sport: 'Baseball', pattern: 'occasional', known: 'the Los Angeles Dodgers Hall of Fame pitcher', tip: 'Koufax has done occasional private signings, usually with long waits and high prices, so an alert is the best way not to miss one.' },
  { name: 'Michael Jordan', sport: 'Basketball', pattern: 'rare', known: 'the six-time NBA champion with the Chicago Bulls', tip: 'Jordan almost never signs in public. Authentic autographs come through his long-running exclusive memorabilia deal, so be wary of cheap "signed" items.' },
  { name: 'LeBron James', sport: 'Basketball', pattern: 'rare', known: 'the NBA\'s all-time leading scorer', tip: 'LeBron signs almost only for exclusive memorabilia and card deals; public signings are essentially nonexistent.' },
  { name: 'Stephen Curry', sport: 'Basketball', pattern: 'rare', known: 'the Golden State Warriors guard and four-time champion', tip: 'Curry public signings are very rare; certified memorabilia and card autographs are the common route.' },
  { name: 'Victor Wembanyama', sport: 'Basketball', pattern: 'rare', known: 'the San Antonio Spurs center', tip: 'As a young star under card and memorabilia deals, Wembanyama has done very few public signings so far.' },
  { name: 'Larry Bird', sport: 'Basketball', pattern: 'occasional', known: 'the Boston Celtics Hall of Fame forward', tip: 'Bird signs now and then through private signings; Boston and Indiana promoters are the ones to watch.' },
  { name: 'Wayne Gretzky', sport: 'Hockey', pattern: 'occasional', known: 'hockey\'s all-time leading scorer', tip: 'Gretzky has done private and occasional in-person signings, usually through memorabilia companies, at premium prices.' },
  { name: 'Connor McDavid', sport: 'Hockey', pattern: 'rare', known: 'the Edmonton Oilers captain', tip: 'McDavid signs mainly for card and memorabilia deals, so public signings are rare, especially during the season.' },
  { name: 'Tiger Woods', sport: 'Golf', pattern: 'rare', known: 'the 15-time major champion', tip: 'Tiger famously almost never signs for the public. Certified autographs come through his exclusive memorabilia deal, and fakes are common.' },
  { name: 'Caitlin Clark', sport: 'Basketball', pattern: 'rare', known: 'the Indiana Fever guard', tip: 'Clark public signings have been very rare; certified cards and licensed memorabilia are the usual route.' },
];
