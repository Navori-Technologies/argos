# Play supply tree template

`eas metadata` is iOS-only. Keep Play metadata in the fastlane `supply` layout so it
uploads with fastlane when available and stays diff-able either way:

```
store/android/metadata/
└── es-MX/                       # primary locale = app UI language
    ├── title.txt                # max 30 chars
    ├── short_description.txt    # max 80 chars — the search-result hook
    ├── full_description.txt     # max 4000 chars — derive from product definition
    ├── video.txt                # optional YouTube URL, else empty
    └── images/
        ├── icon.png             # 512x512
        ├── featureGraphic.png   # 1024x500 — required for store listing
        ├── phoneScreenshots/    # 2–8, ≥1080px wide, from the Maestro run
        ├── sevenInchScreenshots/   # only if tablet UI exists
        └── tenInchScreenshots/     # only if tablet UI exists
```

Upload: `fastlane supply --metadata_path store/android/metadata --skip_upload_apk true --skip_upload_aab true`
(first release: paste manually in Play Console; the repo copy remains the source of truth).
