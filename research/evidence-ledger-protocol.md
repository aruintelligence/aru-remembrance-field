# Evidence ledger challenge

The evidence ledger tests a narrow memory behavior: an exact normalized name maps to a user-entered value with a visible source. It keeps conflicting assertions visible and withholds a single answer until the user makes an explicit choice. It is separate from the freeform field simulation and its modeled μ score.

## Reproduce in the browser

Open **Evidence memory** in the [live demo](https://aruintelligence.github.io/aru-remembrance-field/). Use a fresh browser state or names you have not previously recorded. These are separate probes; erase local state between probes if you want a blank ledger.

| Action | Expected result |
| --- | --- |
| Record `favorite color` = `teal`; recall `FAVORITE  COLOR` | Return `teal` and source #1. Case and repeated spaces in the name are normalized. |
| Recall `favorite animal` with no matching entry | No recorded fact; no value returned. |
| Record `favorite color` = `teal`, then `favorite color` = `amber`; recall it | Conflict with both source numbers; no single value returned. |
| Select source #1 in that conflict; recall it | Return `teal` with source #1. The `amber` record remains marked superseded. |
| Add `violet` to the resolved name; recall it | Conflict again; a new assertion cannot silently override the chosen source. |
| Delete the chosen source when only superseded records remain | Withhold an answer until a remaining record is explicitly selected. |

The test suite runs these transitions in `tests/field.test.cjs`. It also checks that fact records survive a reload, do not change the freeform memory or score, render entered markup as text, reject malformed stored records, and refuse to evict a record silently at the 100-entry limit. Run `node tests/field.test.cjs` from the repository root.

## Interpretation and limits

The lookup is exact after Unicode NFKC normalization, lowercasing, and whitespace collapse on the name. It does not infer that `favourite colour`, `shirt color`, or a natural-language question refers to `favorite color`. Values are compared exactly after trimming, so a change in capitalization also creates a conflict. Values are user assertions, not verified claims about the world. Source numbers identify local entries and can be changed by someone with access to browser storage. This challenge demonstrates a deterministic abstention rule and explicit conflict resolution, not general language understanding, human benefit, or authenticated provenance.
