// 256 short, distinct, easy-to-say words: one byte each.
// Used for room passphrases and for the safety words two people read aloud to each other.

export const WORDS = `
acorn agate alarm alpine amber anchor angel apple apron arrow aspen atlas attic autumn badger
bagel bamboo banjo barley basil beacon beetle berry biscuit bison blanket blossom bobcat bonfire bramble breeze
brick bridge bronze bubble buckle buffalo button cabin cactus camel candle canyon carrot castle cedar cello
chalk cherry chimney cider cinder circus clover cobalt cocoa comet copper coral cosmos cotton cougar coyote
crane crayon cricket crystal cupcake cypress daisy dancer dawn delta denim desert dingo dolphin domino dragon
drum dune eagle echo eel ember emerald falcon feather fennel ferret fiddle fig firefly fjord flamingo flute
fog forest fossil fox galaxy garden garlic gazelle gecko geyser ginger glacier globe goblin goose granite
grape gravel guitar gull hammock harbor harp hazel heron hickory honey hornet husky iceberg igloo
indigo iris island ivory jackal jade jaguar jasmine jelly jester jigsaw juniper kayak kettle kiwi koala
lagoon lantern lava lemon lilac lily linen lizard llama lobster locket lotus lynx magnet mango maple marble
meadow melon meteor mint mitten mocha moose moss moth muffin mushroom nectar needle nickel nutmeg oasis
ocean olive onyx opal orbit orchid otter owl oyster paddle panda papaya parrot peach pebble pelican pepper
pickle pigeon pine pixel plum polar pony poppy prairie prism puffin pumpkin quartz quill quokka
rabbit radish rain raven reef ribbon river robin rocket rose ruby saffron sage salmon satchel scarf
sequoia shadow shell sierra silver sketch sled sloth snail sorbet sparrow spruce squid stardust stork sunset
swan tango thistle thunder tiger timber toast topaz tulip tundra turtle velvet violet walnut walrus willow
`.trim().split(/\s+/);

if (WORDS.length !== 256 || new Set(WORDS).size !== 256) throw new Error(`word list must be 256 unique words, got ${WORDS.length}`);
