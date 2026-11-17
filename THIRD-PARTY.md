Portions of this software are derived from work licensed as follows:

MIT License
Copyright (c) 2026 Hussain
Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions: The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.

---

Fable, the Knot's voice, ships in `resources/voice/kokoro-multi-lang-v1_0` (from 0.1.20):

- Kokoro-82M v1.0 model and voices (hexgrad), as converted for sherpa-onnx by k2-fsa
  (`kokoro-multi-lang-v1_0`): Apache License 2.0. The full licence text ships beside the model as `LICENSE`.
- `espeak-ng-data` (pronunciation data from eSpeak NG): GNU General Public License v3.0 or later. The
  data files ship unmodified, exactly as published at https://github.com/espeak-ng/espeak-ng, where the
  source and the licence text are available.

---

Speech to text ships in `resources/whisper` and `resources/whisper-models` (Windows since 0.1.0; the
Mac beta from 2026-11-15):

- whisper.cpp and ggml (Georgi Gerganov and contributors), release b4938: MIT License. The Windows
  build bundles the published Windows binaries; the Mac build bundles `whisper-cli` and
  `whisper-server` compiled from the b4938 source on a macOS runner. The licence text ships beside
  the Mac binaries as `LICENSE`, and is at https://github.com/ggml-org/whisper.cpp.
- `ggml-base.en-q5_1.bin`: OpenAI's Whisper base.en model, converted and quantized for whisper.cpp.
  The Whisper model weights are released by OpenAI under the MIT License
  (https://github.com/openai/whisper).
