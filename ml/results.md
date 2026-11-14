# Role 1 results: held-out evaluation

200 held-out COCO val2017 scenes (disjoint from the 600 calibration scenes, seed 0). k = 32, ridge alpha = 10.0. Truth = Poet-A's frame applied to the mean of all 5 caption embeddings.

**G1: PASS** (Procrustes). Chance: mode 33.3%, (mode, density) 11.1%; majority-mode baseline 36.0%. Retrieval chance R@1 0.5%, R@5 2.5%.

## Mode accuracy and (mode, density) accuracy

| agent | method | mode acc [95% CI] | context acc | density acc | R@1 | R@5 |
|---|---|---|---|---|---|---|
| eyeA | fitted | 53.5% [46.6%, 60.3%] | 26.5% | 50.5% | 22.0% | 66.5% |
| eyeA | ridge | 52.0% [45.1%, 58.8%] | 26.5% | 54.5% | 29.0% | 64.0% |
| eyeA | random | 39.5% [33.0%, 46.4%] | 11.0% | 27.0% | 0.5% | 2.5% |
| poetA | fitted | 74.5% [68.0%, 80.0%] | 54.0% | 71.0% | n/a | n/a |
| poetA | ridge | 74.5% [68.0%, 80.0%] | 54.0% | 71.0% | n/a | n/a |
| poetA | random | 38.0% [31.6%, 44.9%] | 15.5% | 32.0% | n/a | n/a |
| eyeB | fitted | 53.5% [46.6%, 60.3%] | 27.0% | 47.5% | 20.0% | 62.5% |
| eyeB | ridge | 51.5% [44.6%, 58.3%] | 31.0% | 52.5% | 23.0% | 65.5% |
| eyeB | random | 26.5% [20.9%, 33.0%] | 5.5% | 33.5% | 0.0% | 1.0% |
| poetB | fitted | 56.0% [49.1%, 62.7%] | 33.0% | 59.5% | 50.0% | 84.5% |
| poetB | ridge | 59.0% [52.1%, 65.6%] | 32.0% | 57.0% | 52.0% | 87.5% |
| poetB | random | 33.5% [27.3%, 40.3%] | 10.5% | 27.5% | 0.0% | 3.0% |

Poet-A defines the frame (R = I), so its three rows differ only in the random control. Retrieval is Eye/Poet-B -> Poet-A in the common frame.

## Agreement among the four agents

| method | pairwise context | pairwise mode | all four context | all four mode |
|---|---|---|---|---|
| fitted | 25.4% | 49.4% | 5.0% | 19.0% |
| ridge | 28.3% | 51.1% | 6.5% | 21.0% |
| random | 12.7% | 34.4% | 0.0% | 4.0% |

## G1 decision

- eyeA: fitted mode-accuracy Wilson lower bound 46.6% (needs > 36.0%); paired bootstrap fitted - random 95% CI [5.0%, 23.0%].
- eyeB: fitted mode-accuracy Wilson lower bound 46.6% (needs > 36.0%); paired bootstrap fitted - random 95% CI [17.0%, 36.0%].

## Honest limits

- Truth is a caption-based proxy (MPNet on all 5 captions), not human mood labels. The poets' own captions are among those 5, so their accuracy is partly circular; the eyes are the clean test.
- Perception is precomputed offline per agent; alignment and every decision happen live in the browser.
- Demo scenes were chosen by caption-based truth only, from a keyword pool disjoint from these 200.
