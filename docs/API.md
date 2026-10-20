# Local API

Base URL: `http://127.0.0.1:3001/api`. Browser requests go through the frontend's `/api` proxy. Authentication uses an HttpOnly, SameSite=Strict cookie with an eight-hour session. Session IDs are stored as SHA-256 hashes in backend memory, with no MongoDB sessions collection. Logout revokes the in-memory session. Restarting the backend invalidates all logins; saved system data remains in MongoDB.

| Method | Endpoint | Access | Result |
| --- | --- | --- | --- |
| GET | `/health` | Public | Connectivity, database name, collection mapping, and deferred feature flags |
| POST | `/auth/login` | Public | Accepts username/password, sets session cookie |
| POST | `/auth/logout` | Signed in | Revokes session and clears cookie |
| GET | `/auth/me` | Signed in | Account details without password hash |
| GET | `/incident` | Signed in | Active disaster, or null for Super Admin before setup |
| POST | `/incident` | Super Admin | Initializes saved map and generates per-block accounts |
| DELETE | `/incident` | Super Admin | Clears disaster after `confirmation: "CLEAR"` |
| GET | `/incident/accounts` | Admin / Super Admin | Generated account list without hashes |
| GET | `/map` | Admin / Super Admin | Latest map metadata, blocks, annotations (no image bytes) |
| GET | `/map/image` | Admin / Super Admin | Stored PNG |
| GET | `/map/events` | Admin / Super Admin | Authenticated server-sent update events |
| POST | `/map` | Super Admin | Uploads PNG; replacing an image requires its revision |
| PATCH | `/map` | Super Admin | Autosaves drawings, labels, and draft layouts |
| GET | `/reports/mine` | Resident | This unit's existing report or null |
| POST | `/reports` | Resident | Immediately saves the chosen status, before optional details |
| PATCH | `/reports/mine` | Resident | Finalizes optional details for the signed-in unit |
| PATCH | `/floors/:building/:floor` | Admin / Super Admin | Sets cleared/inaccessible/pending search status without changing resident reports |
| GET | `/dashboard` | Admin / Super Admin | Disaster, reports, counts |
| GET | `/items?q=keywords` | Signed in, active disaster | Found items, optionally filtered |
| GET | `/items/:id` | Signed in, active disaster | Found-item details without image bytes |
| GET | `/items/:id/photo` | Signed in, active disaster | Decoded JPEG photo |
| POST | `/items` | Signed in, active disaster | Creates a found-item record |

Upload: `POST /map` with `{ "image": "data:image/png;base64,..." }`; replacing an image requires `revision`. Only still PNG images up to 4 MB and 25 megapixels are accepted. The backend sanitizes, re-encodes, and bounds stored image size.

Save: `PATCH /map` with `{ "revision": 1, "name": "Disaster area", "blocks": [{ "building": 0, "label": "Block A", "floors": 3, "rooms": 2 }], "annotations": [{ "id": "a", "type": "block", "building": 0, "x": 0.5, "y": 0.5 }] }`. Coordinates are normalized to [0,1]. Building markers can also include `w` and `h` as fractions of map width and height (minimum 0.04 and 0.03); both dimensions must be supplied together, and the whole centered label must fit inside the map. Older markers without dimensions keep their automatic size until resized. Building markers also accept optional `fontSize` (8–72 px); omission retains automatic responsive text sizing. Font size is independent of marker w/h and building layouts. Other types: pen (points/color/width), rectangle (x/y/w/h/color/width), text (x/y/text/color/fontSize). Limits: eight blocks, 1–40 floors and 1–20 units per floor for each block, 200 drawings, bounded point counts and document size. Notes render as plain text.

Initialize: `POST /incident` with `{ "mapRevision": 2 }`. Each block needs a clickable label. Before initialization, only Super Admin can authenticate. Accounts are generated per block. Existing pre-map incidents are linked without recreating accounts or reports. Active floor/unit layouts and account prefixes remain locked; label descriptions, positions, and drawings remain editable. Successful edits increment the revision and publish a map event; stale revisions return 409.

Blocks returned by the API include accountPrefix. Prefixes follow labels (Block D → D), independent of building index. Custom labels require an explicit unique A–Z accountPrefix. New single-block setups also use prefixed accounts. Duplicate prefixes return 400; changing an initialized prefix or block letter returns 409.

`GET /dashboard?building=0` returns counts and reports for that map block only; index 0 can refer to Block D. Omitting the query returns aggregate counts. Invalid indexes return 400. Clear Setup also removes the map and blocks Admin/resident login until the next initialization.

Button press: `POST /reports` with `{ "status": "safe" }` or `{ "status": "help" }`. This immediately saves one report for the signed-in unit with blank optional fields and `detailsSubmittedAt: null`. A first save returns 201, an identical status retry returns 200 without creating another report, and choosing the other status afterward returns 409. Unit identity always comes from the authenticated account.

Optional details: `PATCH /reports/mine`. For Safe, send `{ "familyPhone": "+85291234567" }` or `{}`. For Help, send `{ "situation": "Two people need assistance", "location": "Building A stairwell", "contact": "+85291234567" }` or `{}`. Every field is optional; empty or whitespace-only values save as blank. Supplied phone numbers allow 8–15 digits and optional country-code `+`, ignoring spaces, parentheses, and hyphens. The button's status and original reporting time stay unchanged. Submission sets `detailsSubmittedAt`; matching retries return 200, while later edits or status changes are rejected. Existing reports from the previous version remain completed.

The dashboard counts every saved button press, even without a details submission. The admin interface displays `N/A` for blank situation, location, contact, and family contact. The browser resumes unfinished details after reload or a new login. WhatsApp sending remains disabled.

Found item: `{ "photo": "data:image/jpeg;base64,...", "description": "Mickey Mouse toy", "place": "Building A lobby", "category": "Toys", "contact": "finder@example.com" }`. Categories: Toys, Documents, Electronics, Clothing, Other. Finder contact can be a phone or email. Photos must decode as a JPEG, PNG, or WebP, up to 2 MB of input bytes and 25 megapixels. The backend re-encodes a JPEG at up to 1200 × 1200, removes metadata, and stores it inside MongoDB. The frontend first resizes selected photos up to 10 MB.

Keyword searching requires every input word to appear in the combined description, place, or category, ignoring case. It treats punctuation literally and does not use Atlas Search, regex supplied by the client, or AI.

Errors use `{ "error": "Readable explanation" }` with 400 for invalid input, 401 for invalid/expired sessions, 403 for forbidden actions, 404 for missing items/routes, 409 for an existing setup/report or no active disaster, 413 for oversized JSON, 429 for rate limiting, and 503 for unavailable database/services. Error messages never include the database URI. A successful write response is sent only after MongoDB confirms the save.

## Floor searches

`PATCH /floors/0/1` accepts `{ "incidentId": "current-disaster-uuid", "status": "cleared", "note": "", "revision": 0 }`. Building indexes are zero-based; floors are one-based. Status is cleared, inaccessible, or not_started. Notes are optional except that inaccessible requires a nonblank reason, at most 300 characters. The floor must exist in the active initialized map. The incidentId must match the active incident, so a stale page cannot update a new disaster. The server generates record identity from the active incident and validated route; account identity is always authenticated.

Revision 0 means no previous record; each change increments revision. Matching repeats are idempotent. A stale conflicting update returns 409. Only Admin and Super Admin can update status; sessions and active incident are rechecked inside the write queue. Changes publish a floor-search event on the existing authenticated /map/events stream.

Dashboard results include floorSearches and searchProgress: `{ "cleared": 1, "inaccessible": 1, "pending": 3, "total": 5 }`. The building query filters floor progress as well as reports; omitted building means all blocks. Inaccessible floors are not counted as cleared. Safe/help/no-response counts remain independent of floor searches.
