---
'@stathmos/medusa-plugin-reviews': minor
---

Add photo and video review media: uploads through Medusa's File Module
with content-sniffed validation, EXIF stripping, merchant-configurable
size and count limits, media on store review responses, admin media
deletion, and an hourly sweep of uploads never attached to a review.

Stored filenames are generated server-side from the sniffed format plus a
random token, so an upload cannot choose the `Content-Type` its file is
served back with. Uploads are bounded per file, per count, in aggregate
per request, and by an image decode budget; undecodable or over-budget
images return 400 rather than 500. The orphan sweep claims rows with a
conditional delete, so a submission that attaches media mid-sweep cannot
lose it. `multer` is now a declared dependency, which fixes plugin
installs on pnpm hosts.
