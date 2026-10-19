# Remembrance Capsule · product preview

[Open the capsule preview](https://aruintelligence.github.io/aru-remembrance-field/capsule/). This is a separate, local-only gift experience alongside the Remembrance Field research simulation. It is a functional prototype, not an AI chat service or a finished commerce product.

## Make and open a gift

1. Enter the recipient's name, your name, a letter, and one to eight memories. Add optional PNG, JPEG, or WebP photos of up to 600 KB each. For voice, press **Record a voice note** to request microphone access, record for up to 30 seconds, stop, and listen before adding the memory. Or choose an M4A, MP3, WAV, or WebM file of up to 1 MB per memory. The recorder selects an available MP4/AAC or WebM format and offers the file chooser if recording is unavailable; recording and playback support vary by browser. On an iPhone, [Voice Memos can also export a recording to Files as M4A](https://support.apple.com/en-asia/guide/iphone/iph831c37815/ios); trim it if it exceeds the limit. **Save private draft** can download an encrypted checkpoint at any point, including an unfinished letter or the memory, selected photo, or selected audio currently in the editor. Stop recording first. **Resume draft** restores it later with its private passphrase; it asks before replacing work already on the page. Use a different passphrase for the finished gift.
2. Preview the gift. Choose a unique passphrase of at least 12 characters and select **Seal and download**. The browser downloads a versioned JSON file encrypted with AES-256-GCM and a key derived with PBKDF2-SHA256 (310,000 iterations, random 16-byte salt, random 12-byte IV).
3. Give the recipient the file and tell them the passphrase **separately**. They choose **Open a gift**, select the file, and enter the passphrase. They can read, listen, copy written stories, and ask questions about the written memories. Audio playback depends on the recipient's browser and supported codecs. The question feature searches written words only; it does not transcribe recordings. It returns matching source cards with attached voice notes or refuses to invent an answer. It is deterministic word matching, not a language model. **Edit a copy** loads an opened gift into the maker form; it never overwrites the original file and requires a new sealed download to preserve changes.

The fictional sample is available without a file or passphrase. It has written stories only; no real person's story, photo, or voice is bundled. To run a local checkout, serve the repository over localhost (for example, `python3 -m http.server 8000`) and open `http://localhost:8000/capsule/`; browser module loading and Web Crypto may not work from `file://`.

## Boundaries

- The app makes no API calls or uploads and does not store the draft, passphrase, or opened gift in browser storage. Microphone access is requested only after pressing **Record a voice note**, and its stream is stopped when recording ends or the page is left. Loading the hosted page itself requires a network connection. **There is no automatic backup:** refreshing loses changes since the last private checkpoint. Save new checkpoints after changes and keep copies of downloaded files deliberately. Lost passphrases cannot be recovered here.
- A private checkpoint uses a distinct versioned format and authenticated encryption with the same PBKDF2-SHA256 / AES-256-GCM parameters as a finished gift. It cannot be opened as a recipient gift, and a finished gift cannot be resumed as a private checkpoint. Only give the recipient the finished file, not your private draft.
- The sealed file contains encrypted stories, photos, and voice notes. Anyone with both file and passphrase can decrypt, copy, and reshare them. A guessable passphrase is susceptible to offline guessing; PBKDF2 does not turn a weak passphrase into a strong one. This prototype has not had an external security audit.
- Encryption detects changes to the sealed bytes when opened with the correct passphrase. It does not identify the author, prove a story true, prevent the maker from changing stories before export, or guarantee confidentiality on a compromised device.
- The recipient must trust the page serving this code. The GitHub Pages site is an ordinary web origin whose future code could change. A locally reviewed checkout can be served without internet. The file itself is portable because the source and documented format are in this repository.
- Memories are limited to eight, individual stories to 2,400 characters, photos to 600 KB, audio to 1 MB per memory, and a sealed file to 27 MB. New version 3 gift and draft files support WebM as well as M4A, MP3, and WAV; the reader still opens version 1 and 2 files. Saving an older gift or draft again upgrades its format without discarding its voice note. File headers are checked, but that alone cannot guarantee a recording will decode or that its contents match its description. No accounts, collaboration, payment, live AI model, or cross-device sync are implemented.

## Reproducible checks

```bash
node --test tests/capsule.test.mjs
```

The tests cover encrypt/decrypt, fresh salts and IVs, wrong passphrases, changed ciphertext, unsupported parameters, bounded imports, rejected SVG/spoofed images, cited lexical recall, unfinished checkpoints, real decodable M4A/MP3/WAV/WebM fixtures, version 1 and 2 encrypted file migration, and separation between gift and draft formats. A passing local test does not establish commercial readiness or independent security validation. Actual microphone permissions and playback need device checks.

After changing `core.mjs` or `app.mjs`, run `node tools/update-capsule-assets.mjs` before committing. The content hashes in the module URLs keep a newly deployed page from loading older cached JavaScript. The capsule test fails if a URL does not match its current file.
