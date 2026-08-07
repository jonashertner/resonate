# How two atlases are compared

When someone hands you their atlas, this page compares it with yours and
answers in a word. The comparison happens on your device, in
[js/kinship.js](https://resonate.select/js/kinship.js), which you can read as
it is served. Nothing about the comparison, the word, or what either of you
holds is sent anywhere.

This document exists because a word without its method is still an opaque
judgement, however honest the word. In the app, the report itself shows the
grounds it rests on, counted.

## What counts as the same place

Two places are the same when they sit within **150 metres** of each other.
Names are not compared: the same restaurant is often typed five ways, and a
different door at the same address is usually a different place.

## What counts as standing behind a place

Keeping a place in your atlas is already the recommendation, so the signal is
simply whether you have **been** there and kept it anyway. A place you still
want to go to is hope rather than counsel, and weighs less.

Atlases handed over before August 2026 carry a five-star number instead. Those
are read once: four or five stars is treated as standing behind the place, one
or two as turning away from it. Nothing written today records dislike.

## The three registers

**Common ground.** Every place you both hold, counted. Places you have both
been to and kept count fully; places one of you has only wished for count
less; the rare disagreement, where one has been and kept it and the other
turned away, counts against. This is scaled by how much overlap there is, with
a floor of three so that a single shared place cannot speak for a whole atlas.

**Alignment.** Each atlas becomes a vector of domains, counted from the tags on
its places, and the two are compared by cosine similarity. This asks whether
you read the same sections of the world, regardless of whether you have stood
in the same rooms.

**Expansion.** Domains where they are deep, three places or more, and you are
nearly blank, one or none. This is the part of their atlas that could enlarge
yours, and it counts mildly in their favour rather than against them.

## The blend

Where there is common ground: half the weight to ground, a little over a third
to alignment. Where there is none: alignment carries almost two thirds alone.
Either way, expansion adds up to a small further part. The result is clamped
between zero and one, and then it is thrown away: only the word survives into
the interface.

## The words

Five, in order: **distant**, **faint**, **audible**, **consonant**,
**resonant**. The thresholds are 0.15, 0.35, 0.55 and 0.75. The number behind
them is never shown, because a score invites comparison between people, and
that is not what this is for.

## What they would hand you

Places they hold and you do not, ranked by four things: whether they stand
behind it, whether its domains are ones you already care about, whether it
opens ground you barely touch, and whether they bothered to write a note. The
ranking is the same arithmetic as above, applied one place at a time.

## What this method does not do

It does not learn. There is no profile, no history, and no model: the same two
atlases always produce the same word. It does not rank people against each
other. It has no opinion about quality, only about overlap and difference. And
it never runs anywhere but on the device of the person reading it.
