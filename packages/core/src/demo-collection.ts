import type { CollectionRecord, MessageRecord } from './storage'
import { formatLocalTimestamp } from './time'

const demoDate = new Date('2026-01-24T17:53:31+05:30')
const demoCreatedAt = demoDate.getTime()

const assistantParagraphs = [
  'A unicorn walked into the Brookside Mall on a rainy Tuesday, hooves clicking softly on the polished tile like someone tapping a spoon against a saucer. Outside, the parking lot was a gray puddle-world, but inside everything shone -- glass storefronts, bright signs, the steady hum of people moving with purpose.',
  'The unicorn paused by a fountain that burbled under a skylight, checking its reflection in the water. Its mane looked a little wind-tossed, and a few raindrops clung to its eyelashes like tiny beads. It gave itself a dignified shake, as if to say, I meant to arrive dramatic, and followed the smell it had been chasing since it left the forest: coffee.',
  'The cafe was wedged between a shoe store and a kiosk selling phone cases with glitter in them. A chalkboard sign announced seasonal drinks in looping handwriting. The unicorn ducked under the doorway, horn narrowly missing a string of paper lanterns, and stepped up to the counter.',
  'The barista blinked once, twice, then did what any seasoned mall barista does when presented with the unexpected: smiled like it was completely normal.',
  '"Hi there," she said, adjusting her apron. "What can I get started for you?"',
  "The unicorn cleared its throat in the careful way creatures do when they've practiced being polite in front of deer and owls but not, until now, in front of humans.",
  '"I would like," it said, "a coffee."',
  '"Sure. What kind?"',
  'The unicorn stared at the menu as if it were written in ancient runes. "I do not know the customs of your bean-water," it admitted.',
  'A teenager in line behind it whispered, "Bean-water," like it was the funniest thing they\'d ever heard, and then immediately took a photo, because of course they did.',
  'The barista leaned forward conspiratorially. "Do you like sweet? Creamy? Strong?"',
  '"I like things that taste like sunrise and determination," the unicorn said, then paused. "And perhaps... cinnamon."',
  '"Okay," the barista said, entirely unruffled. "How about a cinnamon latte? Not too strong, not too sweet."',
  '"That sounds like a good first quest," the unicorn said.',
  '"What name should I put on the cup?" the barista asked, marker ready.',
  'The unicorn considered this. Names were important. Names were spells. Names were roots. "You may write," it said at last, "Starlight-of-the-White-Glen."',
  'The barista nodded, wrote STAR in big letters, and slipped the cup into the line of orders.',
  "While it waited, the unicorn wandered a few steps away, careful of a display of pastries. It watched the mall the way you might watch a river -- families drifting by with shopping bags, friends laughing, an elderly man slowly choosing a muffin like it mattered a great deal. Somewhere, a child squealed and then went silent, probably because they'd seen a unicorn and their brain had temporarily shut down.",
  "Sure enough, a small kid tugged on their parent's sleeve and pointed.",
  '"Is that real?" the child asked.',
  'The unicorn lowered its head so its horn didn\'t bump anything and met the child\'s eyes. "I am," it said gently.',
  'The child\'s mouth dropped open. "Do you live in a castle?"',
  '"I live in a glen," the unicorn answered. "But I have seen castles. They are drafty."',
  'The parent, who looked like someone who\'d already had a long week, exhaled slowly and decided -- wisely -- not to question reality in a shopping center. "That\'s... very nice," they managed.',
  'The child smiled so hard it made their cheeks round. "Are you here to buy magic?"',
  'The unicorn glanced back at the cafe, where steam rose behind the counter and the grinder made a sound like distant thunder. "Yes," it said. "In a cup."',
  'A few minutes later, the barista called, "Cinnamon latte for... Star!"',
  'The unicorn approached like it was receiving a royal gift. The cup was small in its enormous presence, a warm paper cylinder with a plastic lid. The barista slid it across the counter with both hands, as if it were a sacred object.',
  '"Careful," she said. "It\'s hot."',
  'The unicorn held it delicately -- somehow making hooves look precise -- and took a tentative sip. Its eyes widened. For a second, the noise of the mall softened around it, as if the latte had turned down the volume of the world.',
  '"It tastes," the unicorn said slowly, "like toasted clouds."',
  'The barista laughed. "I\'ll take that as a compliment."',
  '"It is high praise," the unicorn assured her. Then, after another sip, it added, "Your craft is powerful."',
  'The teenager behind it said, "Can I pet you?" in a voice that tried to be casual and failed.',
  'The unicorn considered the question the way it considered everything: carefully, kindly, with the weight of old rules. "If you ask with respect," it said, "and if you have washed your hands, yes."',
  'A scramble of excitement followed, as if the mall itself had sparked. People formed an awkward, polite line. Someone offered a napkin. Someone else offered a tiny pretzel. The unicorn accepted neither, but it did allow gentle pats along its neck, and each time a hand touched its coat, a faint shimmer appeared -- nothing dramatic, just enough to make the air feel clean and bright for a heartbeat.',
  'By the time it finished its latte, the rain had eased outside. The unicorn stood by the fountain again, sipping the last sweet, cinnamon warmth and watching its reflection with a thoughtful expression.',
  '"Will you come back?" the child asked, still hovering nearby like a friendly sparrow.',
  'The unicorn looked toward the mall doors, then back at the cafe, where the barista was already making another drink, the routine of the day humming along. "Perhaps," it said. "Your world is loud, but it is full of small kindnesses."',
  'The child nodded solemnly, as if that was the most important truth anyone had ever spoken.',
  "The unicorn lifted its head, mane catching the light from the skylight like silver thread. As it walked toward the exit, it left behind hoofprints that weren't wet, exactly, but glittered faintly and then faded -- as if the mall, for just a little while, had been visited by something that belonged to stories.",
  'Outside, the air smelled clean. The unicorn stepped into the damp day, warm with cinnamon and bean-water magic, and trotted away -- already thinking, very seriously, about coming back for something called a "pumpkin spice."',
]

export const demoCollection: CollectionRecord = {
  id: 'collection_demo_unicorn_mall',
  type: 'collection',
  createdAt: demoCreatedAt,
  updatedAt: demoCreatedAt,
  payload: {
    title: 'Tell me a story about a unicorn visiting a mall for a coffee',
    localTimestamp: formatLocalTimestamp(demoDate),
  },
}

const buildDemoMessage = (
  id: string,
  role: 'user' | 'assistant',
  content: string,
  offsetMs: number,
): MessageRecord => {
  const timestamp = demoCreatedAt + offsetMs
  return {
    id,
    type: 'message',
    createdAt: timestamp,
    updatedAt: timestamp,
    payload: {
      role,
      content,
      localTimestamp: formatLocalTimestamp(new Date(timestamp)),
    },
  }
}

export const demoCollectionMessages: MessageRecord[] = [
  buildDemoMessage(
    'message_demo_user',
    'user',
    'Tell me a story about a unicorn visiting a mall for a coffee',
    0,
  ),
  buildDemoMessage(
    'message_demo_assistant',
    'assistant',
    assistantParagraphs.join('\n\n'),
    2000,
  ),
]
