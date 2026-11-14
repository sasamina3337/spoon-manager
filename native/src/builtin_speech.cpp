#include "spoon/builtin_speech.hpp"
#include "spoon/audio.hpp"
#include "builtin_catalog.hpp"
#define VOICEVOX_LOAD_ONNXRUNTIME
#include <voicevox_core.h>
#include <windows.h>
#include <algorithm>
#include <array>
#include <chrono>
#include <filesystem>
#include <list>
#include <memory>
#include <mutex>

namespace spoon {
using Json = nlohmann::json;
const Json& builtin_voice_manifest() {
    static const auto manifest = Json::parse(spoon_builtin_catalog);
    return manifest;
}
const Json& builtin_voices() { return builtin_voice_manifest().at("voices"); }
bool builtin_voice_known(const Json& id) {
    return id.is_number_integer() && std::any_of(builtin_voices().begin(), builtin_voices().end(),
        [&](const auto& voice) { return voice.at("id") == id; });
}
bool builtin_terms_accepted(const Json& settings) {
    return settings.value("voiceTermsAccepted", Json()) == builtin_voice_manifest().at("termsRevision");
}
bool builtin_additional_terms_accepted(const Json& settings) {
    const auto use = settings.value("additionalVoiceUse", Json());
    return settings.value("avoidRestrictedVoices", Json(true)) == false &&
        settings.value("additionalVoiceTermsAccepted", Json()) == builtin_voice_manifest().at("additionalTermsRevision") &&
        (use == "personalNoncommercial" || use == "licensed");
}
bool builtin_voice_allowed(const Json& id, const Json& settings) {
    return id.is_number_integer() && std::any_of(builtin_voices().begin(), builtin_voices().end(),
        [&](const auto& voice) { return voice.at("id") == id &&
            (!voice.value("requiresAdditionalConsent", false) || builtin_additional_terms_accepted(settings)); });
}
Json builtin_available_voices(const Json& settings) {
    auto voices = Json::array();
    for (const auto& voice : builtin_voices())
        if (!voice.value("requiresAdditionalConsent", false) || builtin_additional_terms_accepted(settings)) voices.push_back(voice);
    return voices;
}
namespace {
void check_stop(std::stop_token stop) {
    if (stop.stop_requested()) throw AudioError(499, "読み上げを停止しました。");
}
std::string utf8_path(const std::filesystem::path& path) {
    const auto value = path.u8string();
    return {reinterpret_cast<const char*>(value.data()), value.size()};
}
std::filesystem::path resource_root() {
    std::wstring executable(32768, L'\0');
    const auto size = GetModuleFileNameW(nullptr, executable.data(), static_cast<DWORD>(executable.size()));
    if (!size || size >= executable.size()) throw AudioError(500, "内蔵音声の場所を取得できません。");
    executable.resize(size);
    return std::filesystem::path(executable).parent_path() / L"voicevox";
}
void success(VoicevoxResultCode result) {
    if (result != VOICEVOX_RESULT_OK) throw AudioError(500, "内蔵VOICEVOXの処理に失敗しました。配布ファイル一式を展開し直してください。");
}

class Engine {
    // The CORE and ONNX modules remain loaded for process lifetime: ONNX's
    // load_once reference must remain valid even after a synthesizer is freed.
    HMODULE module_ = nullptr;
    std::filesystem::path root_;
    std::timed_mutex mutex_;
    VoicevoxSynthesizer* synth_ = nullptr;
    struct Loaded { std::string file; std::array<uint8_t, 16> id; };
    std::list<Loaded> loaded_;
#define VV_FUNCTION(name) decltype(&name) name##_ = nullptr
    VV_FUNCTION(voicevox_get_version);
    VV_FUNCTION(voicevox_onnxruntime_load_once);
    VV_FUNCTION(voicevox_make_default_load_onnxruntime_options);
    VV_FUNCTION(voicevox_open_jtalk_rc_new);
    VV_FUNCTION(voicevox_open_jtalk_rc_delete);
    VV_FUNCTION(voicevox_synthesizer_new);
    VV_FUNCTION(voicevox_synthesizer_delete);
    VV_FUNCTION(voicevox_make_default_initialize_options);
    VV_FUNCTION(voicevox_voice_model_file_open);
    VV_FUNCTION(voicevox_voice_model_file_delete);
    VV_FUNCTION(voicevox_voice_model_file_id);
    VV_FUNCTION(voicevox_voice_model_file_create_metas_json);
    VV_FUNCTION(voicevox_synthesizer_load_voice_model);
    VV_FUNCTION(voicevox_synthesizer_unload_voice_model);
    VV_FUNCTION(voicevox_make_default_load_voice_model_options);
    VV_FUNCTION(voicevox_synthesizer_create_audio_query);
    VV_FUNCTION(voicevox_synthesizer_synthesis);
    VV_FUNCTION(voicevox_make_default_synthesis_options);
    VV_FUNCTION(voicevox_string_free);
    VV_FUNCTION(voicevox_bytes_free);
#undef VV_FUNCTION
    template<class T> void load(T& target, const char* symbol) {
        target = reinterpret_cast<T>(GetProcAddress(module_, symbol));
        if (!target) throw AudioError(500, "内蔵VOICEVOXのバージョンが一致しません。配布ファイル一式を展開し直してください。");
    }
public:
    Engine() : root_(resource_root()) {
        module_ = LoadLibraryExW((root_ / L"runtime/voicevox_core.dll").c_str(), nullptr,
            LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS);
        if (!module_) throw AudioError(500, "内蔵VOICEVOXが見つかりません。DLL・辞書・モデルを含む配布ファイル一式を展開してください。");
#define VV_LOAD(name) load(name##_, #name)
        VV_LOAD(voicevox_get_version);
        VV_LOAD(voicevox_onnxruntime_load_once);
        VV_LOAD(voicevox_make_default_load_onnxruntime_options);
        VV_LOAD(voicevox_open_jtalk_rc_new);
        VV_LOAD(voicevox_open_jtalk_rc_delete);
        VV_LOAD(voicevox_synthesizer_new);
        VV_LOAD(voicevox_synthesizer_delete);
        VV_LOAD(voicevox_make_default_initialize_options);
        VV_LOAD(voicevox_voice_model_file_open);
        VV_LOAD(voicevox_voice_model_file_delete);
        VV_LOAD(voicevox_voice_model_file_id);
        VV_LOAD(voicevox_voice_model_file_create_metas_json);
        VV_LOAD(voicevox_synthesizer_load_voice_model);
        VV_LOAD(voicevox_synthesizer_unload_voice_model);
        VV_LOAD(voicevox_make_default_load_voice_model_options);
        VV_LOAD(voicevox_synthesizer_create_audio_query);
        VV_LOAD(voicevox_synthesizer_synthesis);
        VV_LOAD(voicevox_make_default_synthesis_options);
        VV_LOAD(voicevox_string_free);
        VV_LOAD(voicevox_bytes_free);
#undef VV_LOAD
        if (voicevox_get_version_() != builtin_voice_manifest().at("version").get<std::string>())
            throw AudioError(500, "内蔵VOICEVOXのバージョンが一致しません。");
        const auto runtime = utf8_path(root_ / L"runtime/voicevox_onnxruntime.dll");
        auto options = voicevox_make_default_load_onnxruntime_options_();
        options.filename = runtime.c_str();
        const VoicevoxOnnxruntime* ort = nullptr;
        success(voicevox_onnxruntime_load_once_(options, &ort));
        OpenJtalkRc* dictionary = nullptr;
        const auto path = utf8_path(root_ / L"open_jtalk_dic_utf_8-1.11");
        success(voicevox_open_jtalk_rc_new_(path.c_str(), &dictionary));
        auto release = [this](OpenJtalkRc* value) { voicevox_open_jtalk_rc_delete_(value); };
        std::unique_ptr<OpenJtalkRc, decltype(release)> guard(dictionary, release);
        auto initialize = voicevox_make_default_initialize_options_();
        initialize.acceleration_mode = VOICEVOX_ACCELERATION_MODE_CPU;
        initialize.cpu_num_threads = 2;
        success(voicevox_synthesizer_new_(ort, dictionary, initialize, &synth_));
    }
    ~Engine() { if (synth_) voicevox_synthesizer_delete_(synth_); }
    std::string synthesize(const std::string& text, unsigned style, double speed, std::stop_token stop) {
        std::unique_lock lock(mutex_, std::defer_lock);
        while (!lock.try_lock_for(std::chrono::milliseconds(20))) check_stop(stop);
        check_stop(stop);
        const auto& voices = builtin_voices();
        const auto selected = std::find_if(voices.begin(), voices.end(), [&](const auto& v) { return v.at("id") == style; });
        const auto file = selected->at("model").get<std::string>();
        auto cached = std::find_if(loaded_.begin(), loaded_.end(), [&](const auto& item) { return item.file == file; });
        if (cached == loaded_.end()) {
            VoicevoxVoiceModelFile* model = nullptr;
            const auto path = utf8_path(root_ / L"models" / std::filesystem::path(file)); // Fixed ASCII filename from reviewed manifest.
            success(voicevox_voice_model_file_open_(path.c_str(), &model));
            auto release = [this](VoicevoxVoiceModelFile* value) { voicevox_voice_model_file_delete_(value); };
            std::unique_ptr<VoicevoxVoiceModelFile, decltype(release)> guard(model, release);
            char* metadata = voicevox_voice_model_file_create_metas_json_(model);
            auto free_string = [this](char* value) { voicevox_string_free_(value); };
            std::unique_ptr<char, decltype(free_string)> meta_guard(metadata, free_string);
            const auto meta = Json::parse(metadata);
            // Check every reviewed style against the actual model before loading.
            for (const auto& voice : voices) if (voice.at("model") == file) {
                bool found = false;
                for (const auto& speaker : meta) for (const auto& entry : speaker.at("styles"))
                    if (entry.at("id") == voice.at("id") && speaker.at("name") == voice.at("speaker")) found = true;
                if (!found) throw AudioError(500, "内蔵音声モデルと確認済み話者一覧が一致しません。");
            }
            check_stop(stop);
            if (loaded_.size() == 2) {
                uint8_t id[16]; std::copy(loaded_.back().id.begin(), loaded_.back().id.end(), id);
                success(voicevox_synthesizer_unload_voice_model_(synth_, &id));
                loaded_.pop_back();
            }
            success(voicevox_synthesizer_load_voice_model_(synth_, model, voicevox_make_default_load_voice_model_options_()));
            uint8_t id[16]; voicevox_voice_model_file_id_(model, &id);
            Loaded loaded{file, {}}; std::copy(std::begin(id), std::end(id), loaded.id.begin());
            loaded_.push_front(std::move(loaded));
        } else loaded_.splice(loaded_.begin(), loaded_, cached);
        check_stop(stop);
        char* query = nullptr;
        success(voicevox_synthesizer_create_audio_query_(synth_, text.c_str(), style, &query));
        auto free_string = [this](char* value) { voicevox_string_free_(value); };
        std::unique_ptr<char, decltype(free_string)> query_guard(query, free_string);
        auto body = Json::parse(query);
        body["speedScale"] = speed;
        body["volumeScale"] = 1.0; // Playback applies the user's volume once.
        const auto encoded = body.dump();
        check_stop(stop);
        uintptr_t length = 0; uint8_t* wav = nullptr;
        success(voicevox_synthesizer_synthesis_(synth_, encoded.c_str(), style,
            voicevox_make_default_synthesis_options_(), &length, &wav));
        auto free_bytes = [this](uint8_t* value) { voicevox_bytes_free_(value); };
        std::unique_ptr<uint8_t, decltype(free_bytes)> wav_guard(wav, free_bytes);
        check_stop(stop); // A stopped job must never reach playback.
        if (!wav || !length || length > 20'000'000) throw AudioError(500, "内蔵音声が空か長すぎます。");
        return {reinterpret_cast<const char*>(wav), length};
    }
};
}
std::string synthesize_builtin(const std::string& text, unsigned style, double speed, std::stop_token stop) {
    check_stop(stop);
    if (!builtin_voice_known(style)) throw AudioError(400, "この話者は内蔵モデルに含まれません。声の一覧を更新してください。");
    static Engine engine;
    return engine.synthesize(text, style, speed, stop);
}
}
