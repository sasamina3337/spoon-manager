#include "spoon/audio.hpp"
#include "spoon/builtin_speech.hpp"
#include <iostream>
#include <set>
#include <stdexcept>

using Json = nlohmann::json;
void require(bool value, const char* message) { if (!value) throw std::runtime_error(message); }
template<class F> void rejects(F&& operation, int status) {
    try { operation(); } catch (const spoon::AudioError& e) { require(e.status == status, "Wrong rejection status"); return; }
    throw std::runtime_error("Expected audio rejection");
}
int main() {
    try {
        spoon::Audio audio;
        Json settings{{"provider", "builtin"}, {"systemSpeaker", 3}};
        rejects([&] { audio.synthesize("確認", settings); }, 400);
        settings["voiceTermsAccepted"] = "old-terms";
        rejects([&] { audio.synthesize("確認", settings); }, 400);
        settings["voiceTermsAccepted"] = spoon::builtin_voice_manifest().at("termsRevision");
        require(spoon::builtin_available_voices(settings).size() == 92, "Default catalog changed");
        // Conditional speakers require a current, explicit additional-use consent.
        for (const int excluded : {13, 20, 47, 55, 74, 90, 126}) {
            settings["systemSpeaker"] = excluded;
            rejects([&] { audio.synthesize("確認", settings); }, 400);
        }
        settings["systemSpeaker"] = 3;
        std::stop_source stopped; stopped.request_stop();
        rejects([&] { audio.synthesize("確認", settings, stopped.get_token()); }, 499);
        settings["avoidRestrictedVoices"] = false;
        settings["systemSpeaker"] = 13;
        rejects([&] { audio.synthesize("確認", settings); }, 400);
        settings["additionalVoiceTermsAccepted"] = "old-terms";
        rejects([&] { audio.synthesize("確認", settings); }, 400);
        settings["additionalVoiceTermsAccepted"] = spoon::builtin_voice_manifest().at("additionalTermsRevision");
        rejects([&] { audio.synthesize("確認", settings); }, 400);
        settings["additionalVoiceUse"] = "personalNoncommercial";
        require(spoon::builtin_available_voices(settings).size() == 132, "Personal catalog missing voices");
        settings["additionalVoiceUse"] = "licensed";
        require(spoon::builtin_available_voices(settings).size() == 132, "Licensed users were blocked");
        for (const auto& voice : spoon::builtin_voices())
            require(spoon::builtin_voice_allowed(voice.at("id"), settings), "Personal style was not allowed");
        for (const int excluded : {47, 48, 49, 50, 126}) {
            settings["systemSpeaker"] = excluded;
            rejects([&] { audio.synthesize("確認", settings); }, 400);
        }
        settings["avoidRestrictedVoices"] = true;
        settings["systemSpeaker"] = 13;
        rejects([&] { audio.synthesize("確認", settings); }, 400);
        settings["avoidRestrictedVoices"] = false;
        // Real offline synthesis, no network and no output device. One style
        // from every VVM also checks all reviewed metadata in that model.
        std::set<std::string> checked;
        for (const auto& voice : spoon::builtin_voices()) {
            if (!checked.insert(voice.at("model").get<std::string>()).second) continue;
            settings["systemSpeaker"] = voice.at("id");
            const auto bytes = audio.synthesize("こんにちは。音声の確認です。", settings);
            const auto pcm = spoon::audio_detail::parse_wav(bytes);
            require(pcm.sample_rate >= 24000 && !pcm.samples.empty(), "Invalid built-in WAV");
            std::cout << voice.at("model") << ": " << pcm.samples.size() << " samples\n";
        }
        settings["systemSpeaker"] = 3;
        settings["speed"] = 0.5;
        const auto slow = spoon::audio_detail::parse_wav(audio.synthesize("読み上げ速度を確認します。", settings));
        settings["speed"] = 2.0;
        const auto fast = spoon::audio_detail::parse_wav(audio.synthesize("読み上げ速度を確認します。", settings));
        require(slow.samples.size() > fast.samples.size() * 2, "Built-in speed ignored");
        const auto result = audio.diagnose(settings);
        require(result.at("ok") == true && result.at("requests").at(0).at("local") == true, "Offline diagnostic failed");
        std::cout << "Offline models, terms gate, excluded style, cancellation, WAV decoding and speed passed.\n";
    } catch (const std::exception& e) { std::cerr << e.what() << '\n'; return 1; }
}
