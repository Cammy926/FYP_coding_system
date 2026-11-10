# Database design

Server: the configured Azure Cosmos DB MongoDB endpoint. Database: `auto_safety_report`. Each kind of application data has its own collection; login accounts use **`user`**.

| Collection | Important fields |
| --- | --- |
| user | _id=username, username, role, passwordHash, createdAt; residents also have incidentId, building, floor, room |
| incidents | _id=current, incidentId UUID, name, buildings, floors, rooms, status, createdAt, createdBy; setupComplete, whatsappClientId, setupCompletedAt, whatsappLinkedAt |
| safety_reports | _id=incidentId:username; incidentId, userId, username, building, floor, room, status, situation, location, contact, familyPhone, injuries, injuryStepCompletedAt, revision, detailsSubmittedAt, notificationStatus, createdAt |
| whatsapp_replies | _id=incidentId:requestId; incidentId, phone, senderKey, body, repliedBy, state, messageId, sentAt, createdAt |
| floor_searches | _id=incidentId:building:floor; incidentId, building, floor, status, note, revision, createdAt, updatedAt, updatedBy |
| disaster_maps | _id=current; sanitized PNG, imageId, name, blocks, annotations, phase, incidentId, revision, createdAt, updatedAt |
| found_items | _id UUID; incidentId, description, place, category, contact, photo JPEG data URL, createdBy, createdAt |

`backend/store.js` maps the API's logical `users` group to the physical `user` collection. Other groups use the collection names shown above. Documents use ordinary application IDs without recordType or recordId wrappers. A clear operation removes the active incident's records only; manager accounts remain. Future search features can add their own collections to this database.

Building indexes are zero-based map references, not block letters: index 0 can be Block D. Floors and rooms are one-based. Each block saves a unique accountPrefix (A–Z), derived from labels such as Block D or chosen for a custom label. New accounts use this prefix, e.g. D-204. Older preserved single-building setups use an empty prefix and keep names such as 204. No-response units are derived from the layout rather than storing empty reports.

Passwords use Node scrypt with individual random salts. Sessions store token hashes, not the raw cookie. Manager passwords from `.env` seed only new accounts; changing those variables does not reset existing passwords.

Each collection's unique `_id` index enforces account identities, a single current incident, and one report per unit. Secondary incidentId indexes support incident cleanup.

Login sessions use SHA-256 token hashes in backend memory, with eight-hour expiration and immediate logout revocation. No sessions collection is used or created. Restarting the backend requires users to log in again. Clear Setup revokes resident sessions for the cleared incident while retaining manager sessions until they expire or log out.

## Safety report flow

A Safe / I need help button press immediately creates the report. `detailsSubmittedAt: null` means its optional form is unfinished, but the admin dashboard already counts its status. Blank optional fields remain empty strings in MongoDB and display as N/A in the admin interface. The help location is a separate field from the unit's registered building/floor/room.

The optional form submits once using PATCH. Status, user identity, incident identity, and createdAt remain locked; detailsSubmittedAt records completion. Matching retries are idempotent. Reloading or logging in again resumes the unfinished form. Reports created before this change lack detailsSubmittedAt and remain completed. No migration of existing records is required.

## Setup and clear consistency

Run one backend process against this database. The checkout's server lock prevents accidentally starting another backend from the same folder. A write queue serializes setup, clear, reporting, item saves, login-session creation, and logout.

Setup reserves the current incident with status provisioning, hashes/inserts accounts in batches, then marks it active. Requests cannot use a partially configured disaster. Failed setup rolls back its own records; startup recovers interrupted provisioning before login opens.

Clear marks the incident clearing, removes that incident's accounts, reports, and found items, then removes the incident record last and revokes its in-memory unit sessions. Interrupted clear finishes on startup. Manager accounts and manager sessions remain.

This is recoverable sequencing rather than a transaction. Do not run multiple backends against the same database or edit active records directly in Compass.

## Migration

Records from the previous `FYP-SafetySystem` collection have been copied and verified into the separate collections. Their original IDs, password hashes, relationship fields, timestamps, and photos are preserved. You have deleted `FYP-SafetySystem`; the application does not read, write, or recreate it. Historical migration utilities do not run on startup. They copy persistent system records only and skip old login sessions.

`npm run db:migrate-collections` inside backend performs this migration when the backend is stopped. It checks all destination identities before copying, refuses conflicting records, verifies every saved document, and retains the source. Repeating it immediately after migration does not duplicate records. If live data has changed since migration, it refuses to overwrite those changes.

The original local data files remain unchanged, with local connection settings privately saved in `backend/.env.local`. `npm run db:migrate-local` supports legacy separate local collections, legacy mixed records, and the current separate-collection format. Neither migration runs automatically during startup.

Existing unrelated Azure databases and collections are untouched. The frontend/backend stay on localhost, while Azure stores the system records. The backend requires internet access and does not fall back to a second database silently.

## Disaster map

One current map is saved in disaster_maps. Its sanitized PNG and vector annotations occupy one bounded document. Metadata endpoints omit image bytes; the image has an authenticated endpoint. Normalized coordinates keep drawings aligned across screen sizes. Initial setup drafts autosave. After initialization, editor changes stay local until Super Admin clicks Save; only that acknowledged PATCH updates MongoDB and publishes the map event. Leaving the editor without saving discards local changes. Revision checks reject stale edits with 409. Manager windows receive live update events and reload the latest saved map; periodic refresh also recovers missed events.

Each block stores a label, stable building index, accountPrefix, floors, and units per floor. Counts and account generation sum each block independently. Editing a label description does not change resident account IDs; changing its block letter/account prefix after initialization is rejected. Every initialized block retains a clickable marker. Drawing types are pen, rectangle, text/emoji, and block marker.

New maps begin as drafts. Initialization reserves a provisioning incident, creates accounts in batches, links the map, and activates the incident. Interrupted provisioning retains the draft map and removes partial accounts. Interrupted clearing removes the map and incident data. For existing incidents, map setup links to their existing layout and preserves accounts and reports. Only Super Admin can log in until the map is active and linked. Map writes require Super Admin; admins can read and open block overviews.

Building label size is independent of floor/unit layouts. Optional normalized marker w/h fields store the visible width/height with its centered x/y position. Existing markers without these fields retain their original automatic sizing. Resizing uses draft autosave before initialization and explicit Save afterward, with the same revision checks and live manager updates as other drawing edits.

Building marker annotations may include fontSize (8–72 px), independent of their w/h and floor/unit layout. Existing markers without it retain automatic responsive font sizing. Font edits use the same Save/revision/live-update flow as other drawing edits and persist without a database migration.

## Floor search state

floor_searches stores one current record per incident, building, and floor. Its deterministic _id prevents duplicates and isolates equal floor numbers in different blocks or disasters. An incidentId index supports overview queries and cleanup. Status is cleared, inaccessible, or not_started; an absent record also means not_started. Inaccessible records need a reason; notes are limited to 300 characters.

PATCH operations validate the active map layout, role, and session, then use revision checks to prevent lost updates. Identical retries do not double-count progress. Reopening saves a new revision rather than deleting the record, so old editor windows cannot overwrite it with revision 0. Write acknowledgments precede success and live floor-search events. UI merges per-record revisions so an older background poll cannot undo a newer saved floor state.

This collection is independent of safety_reports: clearing a floor means a team completed its search, not that every resident is safe. No status, help details, contacts, or timestamps in safety_reports are changed. Progress sums floor counts independently of unit counts and separates inaccessible floors from completed searches. Incident clear/recovery also removes its floor-search records.

## Block identity upgrade

`blockIdentityVersion: 1` marks incidents using named prefixes. Before HTTP starts, `backend/block-accounts.js` upgrades older active maps. It resolves block letters independently of placement order, verifies every report fits its named block’s layout, and writes an EJSON snapshot with restricted file permissions in ignored `backend/.backups/` before changing records. It preserves existing account IDs/password hashes and report content while correcting building references by username; it creates missing accounts and removes unused out-of-layout accounts only after backup. Map image/annotations, found items, and floor_searches are preserved. The version marker is written last so interrupted repairs can be rerun. Ambiguous prefixes, conflicting accounts, or unmappable reports stop startup for review before writes. Old single-building unprefixed accounts remain unchanged.

## Injury reporting

Injuries stay inside the existing safety_reports document. No extra collection or destructive migration is required. New reports have injuries: [], injuryStepCompletedAt: null, and revision: 1. Only Help reports may select categories. An injury tap adds/removes one allowlisted string with $addToSet/$pull and increments revision; duplicate requests do not add duplicate choices or increase the revision. Continue separately saves injuryStepCompletedAt. Finalizing optional details increments revision and locks further injury edits. The original safety status, identity, and createdAt stay fixed throughout.

Older reports without injury fields are treated as having no selected categories. An unfinished older Help report can use the new step immediately; completed historical reports remain completed. Category counts are derived from the selected block's Help reports, including unfinished submissions, and count unit reports rather than individual household members. Each unit can contribute once to each of several categories, so category totals may exceed the help-unit count. Unselected categories have zero counts; absent injury information displays N/A in report details.

The authenticated manager SSE stream sends reports events after acknowledged report writes. Revisions protect resident selection state from older polling responses, while refresh ordering prevents overlapping dashboard requests from restoring older counters. Floor search records and map annotations are independent and unchanged by injury reporting.

## WhatsApp notification queue

No new collection is required. A finalized Safe report can store notificationChannel=whatsapp-web.js, notificationStatus, notificationRecipient (international number), notificationMessage (snapshot), notificationRequestedAt, notificationAttempts, notificationStartedAt, notificationNextAttemptAt, notificationSentAt, notificationMessageId, and notificationError. Only newly finalized Safe reports are queued; historical disabled records stay untouched. A notificationRequestedAt index is created on startup because Azure Cosmos DB requires an index for the queue ordering query. Existing report revision increases with notification status changes.

Atomic claim from pending to sending plus the single backend process prevents concurrent workers from submitting the same job. Offline pending jobs survive restarts. Interrupted/uncertain sending jobs become unknown instead of automatically retrying, because WhatsApp delivery and MongoDB acknowledgement are not a transaction. This reduces duplicate sends but cannot guarantee exactly-once delivery. Connection errors during recipient lookup can retry before sending, up to three attempts.

LocalAuth sender credentials, the temporary QR image, and browser cache stay in ignored private folders on disk. They are not stored in the MongoDB user collection or any sessions collection. Notification results belong to the unit safety report and disappear on Clear Setup with that incident's other report data. Clear Setup first drains any active send and stops new claims, then confirms remote logout and removes the sender profile before deleting incident records. Logout failure preserves the data for retry. Already sent messages remain on WhatsApp.

An active incident may have setupComplete=false while Super Admin links its sender. This is distinct from interrupted provisioning: accounts and the map are complete and must be preserved on startup. The correct sender’s ready event atomically completes initialization; the sender client ID scopes QR callbacks to the same disaster. New disasters use unique sender profiles. Existing active incidents without this flag remain initialized for compatibility. The profile name and lifecycle state are internal metadata, not WhatsApp credentials; credentials remain on local disk.
