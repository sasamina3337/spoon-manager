#ifndef NOMINMAX
#define NOMINMAX
#endif
#include "spoon/audio.hpp"
#include "spoon/http.hpp"
#include "spoon/voice.hpp"
#include "spoon/builtin_speech.hpp"

#include <windows.h>
#include <mmsystem.h>
#include <mmddk.h>
#include <mmdeviceapi.h>
#include <functiondiscoverykeys_devpkey.h>
#include <propvarutil.h>
#include <winhttp.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <mferror.h>
#include <shlwapi.h>
#include <wrl/client.h>

#include <algorithm>
#include <atomic>
#include <bit>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstring>
#include <limits>
#include <mutex>
#include <utility>

namespace spoon {
namespace {
using Json = nlohmann::json;
using Microsoft::WRL::ComPtr;
constexpr std::size_t max_encoded_bytes = 20'000'000;
constexpr std::size_t max_pcm_bytes = 64'000'000;
constexpr auto max_play_time = std::chrono::seconds(180);

[[noreturn]] void canceled() { throw AudioError(499, "読み上げを停止しました。"); }
void check_stop(std::stop_token token) { if (token.stop_requested()) canceled(); }
[[noreturn]] void bad_audio() {
    throw AudioError(400, "音声データが空か破損しているか、未対応の形式です。");
}
[[noreturn]] void bad_settings() { throw AudioError(400, "読み上げの設定を確認してください。"); }
[[noreturn]] void bad_device() {
    throw AudioError(400, "選択した音声の出力先が見つかりません。「設定 → 読み上げ」で出力先を更新し、接続中の機器を選んで設定を保存してください。");
}
std::string string_setting(const Json& settings, const char* name, const char* fallback = "") {
    const auto item = settings.find(name);
    if (item == settings.end()) return fallback;
    if (!item->is_string()) bad_settings();
    return item->get<std::string>();
}
double number_setting(const Json& settings, const char* name, double fallback,
                      double minimum, double maximum) {
    const auto item = settings.find(name);
    if (item == settings.end()) return fallback;
    if (!item->is_number()) bad_settings();
    const double value = item->get<double>();
    if (!std::isfinite(value)) bad_settings();
    return std::clamp(value, minimum, maximum);
}
struct Settings {
    std::string provider, engine_url, key, speaker, device, label;
    std::string speaker_uuid;
    bool coeiroink = false;
    double speed = 1, volume = 1;
};

std::wstring wide(std::string_view value) {
    if (value.size() > static_cast<std::size_t>(std::numeric_limits<int>::max())) bad_settings();
    if (value.empty()) return {};
    const int count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
                                         static_cast<int>(value.size()), nullptr, 0);
    if (!count) bad_settings();
    std::wstring result(count, L'\0');
    if (!MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
                            static_cast<int>(value.size()), result.data(), count)) bad_settings();
    return result;
}
std::string utf8(std::wstring_view value) {
    if (value.empty()) return {};
    const int count = WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()),
                                         nullptr, 0, nullptr, nullptr);
    if (!count) throw AudioError(500, "Unable to enumerate audio outputs.");
    std::string result(count, '\0');
    WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()),
                        result.data(), count, nullptr, nullptr);
    return result;
}

std::string engine_base(std::string value) {
    const auto invalid = [] { throw AudioError(400, "Enter a valid HTTP or HTTPS VOICEVOX ENGINE URL without credentials, query, or fragment."); };
    if (value.empty() || value.size() > 8192 ||
        std::any_of(value.begin(), value.end(), [](unsigned char c) { return c <= 32 || c == 127 || c == '\\'; })) invalid();
    std::wstring url;
    try { url = wide(value); } catch (const AudioError&) { invalid(); }
    URL_COMPONENTS parts{};
    parts.dwStructSize = sizeof(parts);
    parts.dwSchemeLength = parts.dwHostNameLength = parts.dwUserNameLength =
        parts.dwPasswordLength = parts.dwUrlPathLength = parts.dwExtraInfoLength = static_cast<DWORD>(-1);
    if (!WinHttpCrackUrl(url.c_str(), static_cast<DWORD>(url.size()), 0, &parts) ||
        (parts.nScheme != INTERNET_SCHEME_HTTP && parts.nScheme != INTERNET_SCHEME_HTTPS) ||
        !parts.dwHostNameLength || !parts.nPort || parts.dwUserNameLength ||
        parts.dwPasswordLength || parts.dwExtraInfoLength || value.find('?') != value.npos ||
        value.find('#') != value.npos) invalid();
    // Even empty userinfo (http://@host/) is forbidden.
    const auto authority = value.find("://");
    if (authority == value.npos) invalid();
    const auto authority_end = value.find('/', authority + 3);
    if (value.substr(authority + 3, authority_end == value.npos ? value.npos : authority_end - authority - 3).find('@') != value.npos) invalid();
    while (!value.empty() && value.back() == '/') value.pop_back();
    return value;
}

Settings read_settings(const Json& settings) {
    if (!settings.is_object()) bad_settings();
    Settings result;
    if (settings.value("coeiroinkEnabled", false) && settings.value("coeiroinkDirectEnabled", false)) bad_settings();
    result.provider = string_setting(settings, "provider", "engine");
    if (result.provider != "engine" && result.provider != "legacy" && result.provider != "builtin")
        throw AudioError(400, "選択した音声APIには対応していません。");
    const auto speaker = settings.value("systemSpeaker", Json(0));
    const auto coeiroink = coeiroink_voice(speaker);
    if (speaker.is_string() && !coeiroink) bad_settings();
    if (coeiroink && settings.value("coeiroinkDirectEnabled", false)) {
        result.provider = "coeiroink";
        result.engine_url = engine_base(string_setting(settings, "coeiroinkDirectUrl", "http://127.0.0.1:50032"));
        result.speaker = coeiroink->style;
        result.speaker_uuid = coeiroink->uuid;
    } else if (coeiroink && settings.value("coeiroinkEnabled", false)) {
        result.coeiroink = true;
        result.provider = "engine";
        result.engine_url = string_setting(settings, "coeiroinkUrl", "http://127.0.0.1:50132");
        result.speaker = coeiroink->style;
    } else {
        result.engine_url = string_setting(settings, "engineUrl", "http://127.0.0.1:50021");
        if (!coeiroink && (!speaker.is_number_integer() || speaker.get<double>() < 0 || speaker.get<double>() > 9'007'199'254'740'991.0)) bad_settings();
        result.speaker = coeiroink ? "0" : std::to_string(speaker.get<std::uint64_t>());
    }
    if (result.provider == "engine") result.engine_url = engine_base(std::move(result.engine_url));
    if (result.provider == "builtin") {
        if (!builtin_terms_accepted(settings)) throw AudioError(400, "読み上げ設定で内蔵音声の利用規約とクレジットを確認してください。");
        if (!builtin_voice_allowed(speaker, settings)) throw AudioError(400, "この内蔵音声は利用できません。読み上げ設定で音声の利用条件と同意を確認してください。");
    }
    result.key = string_setting(settings, "apiKey");
    if (result.provider == "legacy" && result.key.empty()) throw AudioError(400, "音声APIキーを入力して設定を保存してください。");
    result.speed = number_setting(settings, "speed", 1, 0.5, 2);
    result.volume = number_setting(settings, "volume", 1, 0, 1);
    result.device = string_setting(settings, "outputDeviceId");
    result.label = string_setting(settings, "outputDeviceLabel");
    return result;
}

std::string form_encode(std::string_view value) {
    std::string result;
    constexpr char hex[] = "0123456789ABCDEF";
    for (const unsigned char byte : value) {
        if ((byte >= 'a' && byte <= 'z') || (byte >= 'A' && byte <= 'Z') ||
            (byte >= '0' && byte <= '9') || byte == '*' || byte == '-' || byte == '.' || byte == '_') result += static_cast<char>(byte);
        else if (byte == ' ') result += '+';
        else { result += '%'; result += hex[byte >> 4]; result += hex[byte & 15]; }
    }
    return result;
}
audio_detail::SpeechRequest legacy(const std::string& text, const Settings& settings) {
    return {"POST", "https://deprecatedapis.tts.quest/v2/voicevox/audio/?speaker=" +
        settings.speaker + "&pitch=0&intonationScale=1&speed=" + Json(settings.speed).dump(),
        {{"Content-Type", "application/x-www-form-urlencoded; charset=UTF-8"}},
        "text=" + form_encode(text) + "&key=" + form_encode(settings.key)};
}

std::string known_code(const std::string& body) {
    if (body.size() > 4096) return {};
    const auto known = [](const Json& item) -> std::string {
        if (!item.is_string()) return {};
        const auto value = item.get<std::string>();
        if (value == "invalidApiKey" || value == "notEnoughPoints" || value == "failed") return value;
        return {};
    };
    try {
        const auto parsed = Json::parse(body, nullptr, false);
        if (auto code = known(parsed); !code.empty()) return code;
        if (parsed.is_object()) for (const auto* key : {"error", "code", "status", "message"}) {
            const auto item = parsed.find(key);
            if (item != parsed.end()) if (auto code = known(*item); !code.empty()) return code;
        }
    } catch (const Json::exception&) { /* Only fixed allowlisted codes may escape. */ }
    const auto begin = body.find_first_not_of(" \r\n\t");
    if (begin == body.npos) return {};
    return known(body.substr(begin, body.find_last_not_of(" \r\n\t") - begin + 1));
}
struct ResponseFailure : AudioError {
    bool retryable;
    ResponseFailure(int status, const char* message, bool retryable)
        : AudioError(status, message), retryable(retryable) {}
};
[[noreturn]] void response_error(const HttpResponse& response, const std::string& code) {
    const auto status = response.status;
    const bool retry = status == 500 || status == 502 || status == 503 || status == 504;
    if (code == "invalidApiKey") throw ResponseFailure(status, "音声APIキーが無効です。保存済みのキーを確認してください。", false);
    if (code == "notEnoughPoints") throw ResponseFailure(status, "音声APIのポイントが不足しています。", false);
    if (status == 429) throw ResponseFailure(status, "音声APIの利用上限に達しました。時間をおいて再試行してください。", false);
    if (status == 401 || status == 403) throw ResponseFailure(status, "音声APIへのアクセスが拒否されました。APIキーと利用権限を確認してください。", false);
    if (retry) throw ResponseFailure(status, "音声APIが一時的に利用できません。時間をおいて再試行してください。", true);
    if (code == "failed") throw ResponseFailure(status, "音声合成に失敗しました。選択した声と本文を確認してください。", false);
    throw ResponseFailure(status, "音声APIにリクエストが拒否されました。選択した声と本文を確認してください。", false);
}
void check_response(const HttpResponse& response) {
    const auto code = known_code(response.body);
    if (response.status < 200 || response.status >= 300 || !code.empty()) response_error(response, code);
}
std::string content_type(const HttpResponse& response) {
    // HttpClient returns lowercase header names. Be tolerant of injected fixtures.
    for (const auto& [name, value] : response.headers) {
        auto key = name;
        std::transform(key.begin(), key.end(), key.begin(), [](unsigned char c) { return c >= 'A' && c <= 'Z' ? c + 'a' - 'A' : c; });
        if (key != "content-type") continue;
        auto type = value.substr(0, value.find(';'));
        std::transform(type.begin(), type.end(), type.begin(), [](unsigned char c) { return c >= 'A' && c <= 'Z' ? c + 'a' - 'A' : c; });
        while (!type.empty() && type.back() == ' ') type.pop_back();
        return type;
    }
    return {};
}
HttpResponse fetch(const audio_detail::SpeechRequest& request, std::stop_token stop,
                   const char* stage, Json* requests) {
    check_stop(stop);
    HttpResponse response;
    try { response = HttpClient{}.request(request.method, request.url, request.headers, request.body, stop); }
    catch (const std::exception&) {
        check_stop(stop);
        if (requests) requests->push_back({{"stage", stage}, {"status", 0}});
        throw AudioError(502, "音声APIに接続できません。接続先のURLと、VOICEVOX・COEIROINK・ブリッジの起動状態を確認してください。");
    }
    check_stop(stop);
    if (requests) requests->push_back({{"stage", stage}, {"status", response.status}});
    check_response(response);
    return response;
}
void wait_retry(std::stop_token stop) {
    std::mutex mutex;
    std::condition_variable_any changed;
    std::unique_lock lock(mutex);
    changed.wait_for(lock, stop, std::chrono::seconds(1), [] { return false; });
    check_stop(stop);
}
std::string synthesize_audio(const std::string& text, const Settings& settings,
                             std::stop_token stop, Json* requests = nullptr) {
    if (text.empty() || text.size() > 100'000) throw AudioError(400, "Speech text is empty or too long.");
    (void)wide(text); // Validate UTF-8 before building either request.
    if (settings.provider == "builtin") {
        auto bytes = synthesize_builtin(text, static_cast<unsigned>(std::stoul(settings.speaker)), settings.speed, stop);
        if (requests) requests->push_back({{"stage", "builtin_synthesis"}, {"local", true}, {"status", 0}});
        return bytes;
    }
    for (int attempt = 0; attempt != 2; ++attempt) {
        try {
            check_stop(stop);
            HttpResponse audio;
            if (settings.provider == "coeiroink") {
                const Json body = {{"speakerUuid", settings.speaker_uuid}, {"styleId", std::stoi(settings.speaker)},
                    {"text", text}, {"speedScale", settings.speed}, {"volumeScale", 1.0}, {"pitchScale", 0.0},
                    {"intonationScale", 1.0}, {"prePhonemeLength", 0.0}, {"postPhonemeLength", 0.0},
                    {"outputSamplingRate", 44100}, {"sampledIntervalValue", 0}, {"adjustedF0", Json::array()},
                    {"processingAlgorithm", "coeiroink"}, {"prosodyDetail", Json::array()}};
                audio = fetch({"POST", settings.engine_url + "/v1/synthesis",
                    {{"Content-Type", "application/json"}, {"Accept", "audio/wav"}}, body.dump()}, stop, "synthesis", requests);
            } else if (settings.provider == "legacy") audio = fetch(legacy(text, settings), stop, "synthesis", requests);
            else {
                const auto response = fetch({"POST", settings.engine_url + "/audio_query?text=" +
                    form_encode(text) + "&speaker=" + settings.speaker, {}, {}}, stop, "audio_query", requests);
                const auto type = content_type(response);
                if (type != "application/json" && !(type.starts_with("application/") && type.ends_with("+json")))
                    throw AudioError(502, "VOICEVOX ENGINEから正しい音声クエリを取得できませんでした。");
                Json query = Json::parse(response.body, nullptr, false);
                if (!query.is_object()) throw AudioError(502, "VOICEVOX ENGINEから正しい音声クエリを取得できませんでした。");
                query["speedScale"] = settings.speed;
                std::string body;
                try { body = query.dump(); }
                catch (const Json::exception&) { throw AudioError(502, "VOICEVOX ENGINEから正しい音声クエリを取得できませんでした。"); }
                audio = fetch({"POST", settings.engine_url + "/synthesis?speaker=" + settings.speaker,
                    {{"Content-Type", "application/json"}}, std::move(body)}, stop, "synthesis", requests);
            }
            if (audio.body.empty() || audio.body.size() > max_encoded_bytes) bad_audio();
            const auto type = content_type(audio);
            // coeiroink-v2-bridge streams WAV without a Content-Type header.
            // Limit this exception to the optional bridge and validate the WAV.
            if (settings.coeiroink && type.empty()) (void)audio_detail::parse_wav(audio.body, stop);
            else if (!type.starts_with("audio/")) throw AudioError(502, "音声APIから音声データを取得できませんでした。APIキーと利用可能なポイントを確認してください。");
            check_stop(stop);
            return std::move(audio.body);
        } catch (const ResponseFailure& error) {
            if (!error.retryable || attempt != 0) throw;
            wait_retry(stop);
        }
    }
    throw AudioError(502, "Speech synthesis failed.");
}

std::uint16_t u16(std::string_view bytes, std::size_t offset) {
    if (offset > bytes.size() || bytes.size() - offset < 2) bad_audio();
    return static_cast<unsigned char>(bytes[offset]) | (static_cast<unsigned char>(bytes[offset + 1]) << 8);
}
std::uint32_t u32(std::string_view bytes, std::size_t offset) {
    return u16(bytes, offset) | (static_cast<std::uint32_t>(u16(bytes, offset + 2)) << 16);
}
void validate_pcm(const audio_detail::PcmAudio& pcm) {
    if (!pcm.channels || pcm.channels > 8 || pcm.sample_rate < 8000 || pcm.sample_rate > 192000 ||
        pcm.samples.empty() || pcm.samples.size() % pcm.channels || pcm.samples.size() > max_pcm_bytes / 2 ||
        pcm.samples.size() / pcm.channels > static_cast<std::size_t>(pcm.sample_rate) * 180) bad_audio();
}

struct NativeDevice { std::string id, name, legacy_name, endpoint_id; UINT index; };
std::wstring device_string(UINT index, UINT size_message, UINT message) {
    const auto device = reinterpret_cast<HWAVEOUT>(static_cast<UINT_PTR>(index));
    DWORD size = 0;
    if (waveOutMessage(device, size_message, reinterpret_cast<DWORD_PTR>(&size), 0) != MMSYSERR_NOERROR ||
        size < sizeof(wchar_t) || size > 65536 || size % sizeof(wchar_t)) return {};
    std::wstring value(size / sizeof(wchar_t), L'\0');
    if (waveOutMessage(device, message, reinterpret_cast<DWORD_PTR>(value.data()), size) != MMSYSERR_NOERROR) return {};
    value.resize(value.find(L'\0') == value.npos ? value.size() : value.find(L'\0'));
    return value;
}
// System-intercepted waveOutMessage queries require a device ID, never an open
// playback handle. Keeping the parameter typed as UINT prevents that mix-up.
std::string device_identity(UINT index, const WAVEOUTCAPSW& caps) {
    const auto device = reinterpret_cast<HWAVEOUT>(static_cast<UINT_PTR>(index));
    DWORD size = 0;
    if (waveOutMessage(device, DRV_QUERYDEVICEINTERFACESIZE, reinterpret_cast<DWORD_PTR>(&size), 0) == MMSYSERR_NOERROR &&
        size >= sizeof(wchar_t) && size <= 65536 && size % sizeof(wchar_t) == 0) {
        std::wstring path(size / sizeof(wchar_t), L'\0');
        if (waveOutMessage(device, DRV_QUERYDEVICEINTERFACE, reinterpret_cast<DWORD_PTR>(path.data()), size) == MMSYSERR_NOERROR) {
            const auto end = path.find(L'\0');
            path.resize(end == path.npos ? path.size() : end);
            if (!path.empty()) return "winmm:" + utf8(path);
        }
    }
    // Older drivers may not expose an interface path. Include identity as
    // well as index, so a changed order cannot silently select another name.
    return "winmm:" + std::to_string(caps.wMid) + ":" + std::to_string(caps.wPid) + ":" + std::to_string(index) + ":" + utf8(caps.szPname);
}
std::vector<NativeDevice> native_devices() {
    std::vector<NativeDevice> result;
    struct Apartment {
        HRESULT status = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
        ~Apartment() { if (SUCCEEDED(status)) CoUninitialize(); }
    } apartment;
    ComPtr<IMMDeviceEnumerator> enumerator;
    if (SUCCEEDED(apartment.status) || apartment.status == RPC_E_CHANGED_MODE)
        CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&enumerator));
    const UINT count = waveOutGetNumDevs();
    for (UINT index = 0; index < count; ++index) {
        WAVEOUTCAPSW caps{};
        if (waveOutGetDevCapsW(index, &caps, sizeof(caps)) != MMSYSERR_NOERROR) continue;
        const auto legacy_name = utf8(caps.szPname);
        auto name = legacy_name;
        const auto endpoint = device_string(index, DRV_QUERYFUNCTIONINSTANCEIDSIZE, DRV_QUERYFUNCTIONINSTANCEID);
        ComPtr<IMMDevice> endpoint_device;
        ComPtr<IPropertyStore> properties;
        if (enumerator && !endpoint.empty() && SUCCEEDED(enumerator->GetDevice(endpoint.c_str(), &endpoint_device)) &&
            SUCCEEDED(endpoint_device->OpenPropertyStore(STGM_READ, &properties))) {
            PROPVARIANT value;
            PropVariantInit(&value);
            if (SUCCEEDED(properties->GetValue(PKEY_Device_FriendlyName, &value)) &&
                value.vt == VT_LPWSTR && value.pwszVal && *value.pwszVal) name = utf8(value.pwszVal);
            PropVariantClear(&value);
        }
        result.push_back({device_identity(index, caps), std::move(name), legacy_name, utf8(endpoint), index});
    }
    return result;
}
Json device_json(const std::vector<NativeDevice>& devices) {
    auto result = Json::array();
    for (const auto& device : devices) result.push_back({{"id", device.id}, {"name", device.name},
        {"legacyName", device.legacy_name}, {"endpointId", device.endpoint_id}});
    return result;
}

class WavePlayback {
public:
    HANDLE event = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    HWAVEOUT output = nullptr;
    WAVEHDR header{};
    bool prepared = false;
    ~WavePlayback() {
        // The playback thread owns the handle/header/sample buffer. stop() only
        // signals its token; reset returns all buffers before they are released.
        if (output) {
            waveOutReset(output);
            if (prepared) waveOutUnprepareHeader(output, &header, sizeof(header));
            waveOutClose(output);
        }
        if (event) CloseHandle(event);
    }
};
void play(audio_detail::PcmAudio pcm, const std::string& selected, double volume, std::stop_token stop) {
    check_stop(stop);
    validate_pcm(pcm);
    if (volume != 1) for (std::size_t i = 0; i < pcm.samples.size(); ++i) {
        if ((i & 4095) == 0) check_stop(stop);
        pcm.samples[i] = static_cast<std::int16_t>(std::lround(pcm.samples[i] * volume));
    }
    WavePlayback playback;
    if (!playback.event) throw AudioError(500, "音声再生の準備に失敗しました。");
    WAVEFORMATEX format{};
    format.wFormatTag = WAVE_FORMAT_PCM;
    format.nChannels = pcm.channels;
    format.nSamplesPerSec = pcm.sample_rate;
    format.wBitsPerSample = 16;
    format.nBlockAlign = pcm.channels * 2;
    format.nAvgBytesPerSec = format.nSamplesPerSec * format.nBlockAlign;
    UINT device = WAVE_MAPPER;
    if (!selected.empty()) {
        // Synthesis may take many seconds. Resolve the saved identity again,
        // rather than reusing an index from before a device was unplugged.
        const auto available = native_devices();
        const auto found = std::find_if(available.begin(), available.end(), [&](const auto& item) { return item.id == selected; });
        if (found == available.end()) bad_device();
        device = found->index;
    }
    check_stop(stop);
    if (waveOutOpen(&playback.output, device, &format, reinterpret_cast<DWORD_PTR>(playback.event), 0, CALLBACK_EVENT) != MMSYSERR_NOERROR) {
        if (!selected.empty()) throw AudioError(500, "選択した音声の出力先を開けません。出力先を更新して選び直すか、機器を使用中のアプリを確認してください。");
        throw AudioError(500, "Windowsの既定の音声出力先を開けません。Windowsのサウンド設定を確認してください。");
    }
    if (!selected.empty()) {
        UINT opened_index = 0;
        WAVEOUTCAPSW opened_caps{};
        if (waveOutGetID(playback.output, &opened_index) != MMSYSERR_NOERROR ||
            waveOutGetDevCapsW(reinterpret_cast<UINT_PTR>(playback.output), &opened_caps, sizeof(opened_caps)) != MMSYSERR_NOERROR ||
            device_identity(opened_index, opened_caps) != selected) bad_device();
    }
    check_stop(stop);
    playback.header.lpData = reinterpret_cast<LPSTR>(pcm.samples.data());
    playback.header.dwBufferLength = static_cast<DWORD>(pcm.samples.size() * sizeof(std::int16_t));
    if (waveOutPrepareHeader(playback.output, &playback.header, sizeof(playback.header)) != MMSYSERR_NOERROR)
        throw AudioError(500, "音声再生の準備に失敗しました。");
    playback.prepared = true;
    ResetEvent(playback.event);
    check_stop(stop);
    if (waveOutWrite(playback.output, &playback.header, sizeof(playback.header)) != MMSYSERR_NOERROR)
        throw AudioError(500, "音声の出力に失敗しました。出力先を更新し、機器を選び直してください。");
    const auto deadline = std::chrono::steady_clock::now() + max_play_time;
    for (;;) {
        check_stop(stop);
        if (std::chrono::steady_clock::now() >= deadline) throw AudioError(500, "音声再生がタイムアウトしました。");
        const auto waited = WaitForSingleObject(playback.event, 10);
        if (waited == WAIT_FAILED) throw AudioError(500, "Audio output failed.");
        if (waited == WAIT_OBJECT_0 && (playback.header.dwFlags & WHDR_DONE)) break;
    }
    check_stop(stop);
}

class MediaRuntime {
    bool uninitialize_ = false, started_ = false;
public:
    MediaRuntime() {
        const auto initialized = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
        uninitialize_ = SUCCEEDED(initialized);
        if (FAILED(initialized) && initialized != RPC_E_CHANGED_MODE) bad_audio();
        if (FAILED(MFStartup(MF_VERSION, MFSTARTUP_LITE))) {
            if (uninitialize_) CoUninitialize();
            throw AudioError(500, "Windows Media Foundation is unavailable. Install Windows Media Feature Pack.");
        }
        started_ = true;
    }
    ~MediaRuntime() { if (started_) MFShutdown(); if (uninitialize_) CoUninitialize(); }
};
void media_ok(HRESULT result) { if (FAILED(result)) bad_audio(); }
}

namespace audio_detail {
PcmAudio parse_wav(std::string_view bytes, std::stop_token stop) {
    check_stop(stop);
    if (bytes.size() < 12 || bytes.size() > max_encoded_bytes || bytes.substr(0, 4) != "RIFF" || bytes.substr(8, 4) != "WAVE") bad_audio();
    const auto riff_size = u32(bytes, 4);
    if (riff_size < 4 || static_cast<std::uint64_t>(riff_size) + 8 != bytes.size()) bad_audio();
    std::string_view format, data;
    bool have_format = false, have_data = false;
    for (std::size_t offset = 12; offset < bytes.size();) {
        check_stop(stop);
        if (bytes.size() - offset < 8) bad_audio();
        const auto size = u32(bytes, offset + 4);
        const auto name = bytes.substr(offset, 4);
        offset += 8;
        if (size > bytes.size() - offset) bad_audio();
        if (name == "fmt ") {
            if (have_format) bad_audio();
            format = bytes.substr(offset, size); have_format = true;
        } else if (name == "data") {
            if (have_data) bad_audio();
            data = bytes.substr(offset, size); have_data = true;
        }
        offset += size;
        if (size & 1) { if (offset == bytes.size()) bad_audio(); ++offset; }
    }
    if (!have_format || !have_data || format.size() < 16 || data.empty()) bad_audio();
    auto tag = u16(format, 0);
    const auto channels = u16(format, 2);
    const auto rate = u32(format, 4);
    const auto byte_rate = u32(format, 8);
    const auto align = u16(format, 12);
    const auto bits = u16(format, 14);
    if (format.size() != 16 && (format.size() < 18 || u16(format, 16) > format.size() - 18)) bad_audio();
    if (tag == WAVE_FORMAT_EXTENSIBLE) {
        if (format.size() < 40 || u16(format, 16) < 22 || u16(format, 18) != bits) bad_audio();
        // KSDATAFORMAT_SUBTYPE_PCM / IEEE_FLOAT share the remaining GUID bytes.
        constexpr unsigned char tail[] = {0, 0, 0, 0, 0x10, 0, 0x80, 0, 0, 0xAA, 0, 0x38, 0x9B, 0x71};
        if (std::memcmp(format.data() + 26, tail, sizeof(tail)) != 0) bad_audio();
        tag = u16(format, 24);
    }
    if ((tag != WAVE_FORMAT_PCM && tag != WAVE_FORMAT_IEEE_FLOAT) || !channels || channels > 8 || rate < 8000 || rate > 192000 ||
        (tag == WAVE_FORMAT_PCM && bits != 8 && bits != 16 && bits != 24 && bits != 32) ||
        (tag == WAVE_FORMAT_IEEE_FLOAT && bits != 32) || align != channels * (bits / 8) ||
        byte_rate != rate * align || data.size() % align) bad_audio();
    const auto count = data.size() / (bits / 8);
    if (count > max_pcm_bytes / 2 || count / channels > static_cast<std::size_t>(rate) * 180) bad_audio();
    PcmAudio result{rate, channels, {}};
    result.samples.reserve(count);
    for (std::size_t offset = 0; offset < data.size(); offset += bits / 8) {
        if ((offset & 4095) == 0) check_stop(stop);
        std::int16_t sample = 0;
        if (tag == WAVE_FORMAT_IEEE_FLOAT) {
            const float value = std::bit_cast<float>(u32(data, offset));
            if (!std::isfinite(value)) bad_audio();
            sample = static_cast<std::int16_t>(std::lround(std::clamp(static_cast<double>(value), -1.0, 1.0) * 32767));
        } else if (bits == 8) sample = static_cast<std::int16_t>((static_cast<unsigned char>(data[offset]) - 128) * 256);
        else sample = std::bit_cast<std::int16_t>(u16(data, offset + bits / 8 - 2));
        result.samples.push_back(sample);
    }
    validate_pcm(result);
    check_stop(stop);
    return result;
}

PcmAudio decode_audio(std::string_view bytes, std::stop_token stop) {
    check_stop(stop);
    if (bytes.empty() || bytes.size() > max_encoded_bytes) bad_audio();
    if (bytes.starts_with("RIFF") || (bytes.size() >= 12 && bytes.substr(8, 4) == "WAVE")) return parse_wav(bytes, stop);
    MediaRuntime runtime;
    ComPtr<IStream> stream;
    stream.Attach(SHCreateMemStream(reinterpret_cast<const BYTE*>(bytes.data()), static_cast<UINT>(bytes.size())));
    if (!stream) bad_audio();
    ComPtr<IMFByteStream> byte_stream;
    media_ok(MFCreateMFByteStreamOnStream(stream.Get(), &byte_stream));
    ComPtr<IMFSourceReader> reader;
    media_ok(MFCreateSourceReaderFromByteStream(byte_stream.Get(), nullptr, &reader));
    constexpr DWORD all_streams = static_cast<DWORD>(MF_SOURCE_READER_ALL_STREAMS);
    constexpr DWORD audio_stream = static_cast<DWORD>(MF_SOURCE_READER_FIRST_AUDIO_STREAM);
    media_ok(reader->SetStreamSelection(all_streams, FALSE));
    media_ok(reader->SetStreamSelection(audio_stream, TRUE));
    ComPtr<IMFMediaType> type;
    media_ok(MFCreateMediaType(&type));
    media_ok(type->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Audio));
    media_ok(type->SetGUID(MF_MT_SUBTYPE, MFAudioFormat_PCM));
    media_ok(type->SetUINT32(MF_MT_AUDIO_BITS_PER_SAMPLE, 16));
    media_ok(reader->SetCurrentMediaType(audio_stream, nullptr, type.Get()));
    type.Reset();
    media_ok(reader->GetCurrentMediaType(audio_stream, &type));
    UINT32 channels = 0, rate = 0, bits = 0, align = 0;
    GUID subtype{};
    media_ok(type->GetGUID(MF_MT_SUBTYPE, &subtype));
    media_ok(type->GetUINT32(MF_MT_AUDIO_NUM_CHANNELS, &channels));
    media_ok(type->GetUINT32(MF_MT_AUDIO_SAMPLES_PER_SECOND, &rate));
    media_ok(type->GetUINT32(MF_MT_AUDIO_BITS_PER_SAMPLE, &bits));
    media_ok(type->GetUINT32(MF_MT_AUDIO_BLOCK_ALIGNMENT, &align));
    if (subtype != MFAudioFormat_PCM || bits != 16 || channels == 0 || channels > 8 || rate < 8000 || rate > 192000 || align != channels * 2) bad_audio();
    PcmAudio result{rate, static_cast<std::uint16_t>(channels), {}};
    unsigned empty_samples = 0;
    for (;;) {
        check_stop(stop);
        DWORD flags = 0;
        ComPtr<IMFSample> sample;
        media_ok(reader->ReadSample(audio_stream, 0, nullptr, &flags, nullptr, &sample));
        check_stop(stop);
        if (flags & (MF_SOURCE_READERF_ERROR | MF_SOURCE_READERF_CURRENTMEDIATYPECHANGED)) bad_audio();
        if (sample) {
            ComPtr<IMFMediaBuffer> buffer;
            media_ok(sample->ConvertToContiguousBuffer(&buffer));
            BYTE* source = nullptr;
            DWORD length = 0;
            media_ok(buffer->Lock(&source, nullptr, &length));
            struct Unlock { IMFMediaBuffer* buffer; ~Unlock() { buffer->Unlock(); } } unlock{buffer.Get()};
            if (length % align || length > max_pcm_bytes ||
                result.samples.size() > (max_pcm_bytes - length) / 2) bad_audio();
            const auto old_size = result.samples.size();
            result.samples.resize(old_size + length / 2);
            if (length) std::memcpy(result.samples.data() + old_size, source, length);
            if (result.samples.size() / channels > static_cast<std::size_t>(rate) * 180) bad_audio();
            if (length) empty_samples = 0; else if (++empty_samples > 1024) bad_audio();
        } else if (++empty_samples > 1024) bad_audio();
        if (flags & MF_SOURCE_READERF_ENDOFSTREAM) break;
    }
    validate_pcm(result);
    check_stop(stop);
    return result;
}

std::string resolve_output_device(const Json& devices, const std::string& id, const std::string& label) {
    if (id.empty()) return {}; // A remembered label does not override default.
    if (!devices.is_array()) bad_device();
    std::string match;
    std::size_t matches = 0;
    for (const auto& item : devices) {
        if (!item.is_object() || !item.contains("id") || !item["id"].is_string() ||
            !item.contains("name") || !item["name"].is_string()) continue;
        const auto candidate = item["id"].get<std::string>();
        if (candidate.empty()) continue;
        if (candidate == id) return candidate;
        const auto endpoint = item.find("endpointId");
        if (endpoint != item.end() && endpoint->is_string() && !endpoint->get_ref<const std::string&>().empty() &&
            (id == endpoint->get_ref<const std::string&>() || id == "wasapi:" + endpoint->get<std::string>())) return candidate;
        const auto legacy_name = item.find("legacyName");
        if (!label.empty() && (item["name"].get<std::string>() == label ||
            (legacy_name != item.end() && legacy_name->is_string() && legacy_name->get_ref<const std::string&>() == label))) {
            match = candidate; ++matches;
        }
    }
    if (matches == 1) return match;
    bad_device();
}
SpeechRequest legacy_request(const std::string& text, const Json& settings) {
    const auto parsed = read_settings(settings);
    if (parsed.provider != "legacy") bad_settings();
    return legacy(text, parsed);
}
}

struct Audio::Impl {
    std::atomic<std::uint64_t> generation{0};
    std::mutex mutex;
    std::condition_variable idle;
    std::stop_source active;
    std::size_t jobs = 0;
    bool closing = false;

    struct Job {
        std::shared_ptr<Impl> owner;
        std::stop_source cancel;
        std::uint64_t generation;
        Job(std::shared_ptr<Impl> owner, std::stop_source cancel, std::uint64_t generation)
            : owner(std::move(owner)), cancel(std::move(cancel)), generation(generation) {}
        Job(const Job&) = delete;
        Job& operator=(const Job&) = delete;
        ~Job() { std::lock_guard lock(owner->mutex); --owner->jobs; owner->idle.notify_all(); }
        void check() const {
            if (cancel.stop_requested() || owner->generation.load(std::memory_order_acquire) != generation) canceled();
        }
    };
    static Job begin(const std::shared_ptr<Impl>& owner) {
        std::stop_source previous, next;
        std::uint64_t generation;
        {
            std::lock_guard lock(owner->mutex);
            if (owner->closing) canceled();
            previous = owner->active;
            owner->active = next;
            generation = owner->generation.fetch_add(1, std::memory_order_acq_rel) + 1;
            ++owner->jobs;
        }
        previous.request_stop();
        return Job(owner, next, generation);
    }
    void cancel(bool close = false) {
        std::stop_source source;
        {
            std::lock_guard lock(mutex);
            closing = closing || close;
            generation.fetch_add(1, std::memory_order_acq_rel);
            source = active;
        }
        source.request_stop();
    }
};

Audio::Audio() : impl_(std::make_shared<Impl>()) {}
Audio::~Audio() {
    const auto owner = impl_;
    owner->cancel(true);
    std::unique_lock lock(owner->mutex);
    owner->idle.wait(lock, [&] { return owner->jobs == 0; });
}
Json Audio::devices() const { return device_json(native_devices()); }
void Audio::stop() { impl_->cancel(); }
std::string Audio::synthesize(const std::string& text, const Json& settings, std::stop_token stop) {
    check_stop(stop);
    auto job = Impl::begin(impl_);
    std::stop_callback external(stop, [source = job.cancel]() mutable { source.request_stop(); });
    job.check();
    const auto parsed = read_settings(settings);
    auto bytes = synthesize_audio(text, parsed, job.cancel.get_token());
    job.check();
    return bytes;
}
Json Audio::diagnose(const Json& settings, std::stop_token stop) {
    check_stop(stop);
    auto job = Impl::begin(impl_);
    std::stop_callback external(stop, [source = job.cancel]() mutable { source.request_stop(); });
    Json result{{"ok", false}, {"requests", Json::array()},
        {"checkedAt", std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::system_clock::now().time_since_epoch()).count()}};
    try {
        const auto parsed = read_settings(settings);
        const auto bytes = synthesize_audio("音声の接続テストです。", parsed, job.cancel.get_token(), &result["requests"]);
        const auto pcm = audio_detail::decode_audio(bytes, job.cancel.get_token());
        job.check();
        result["ok"] = true;
        result["message"] = parsed.provider == "builtin" ? "内蔵VOICEVOXの音声合成を確認できました。診断では音声を再生していません。" : "音声APIへの接続と音声合成を確認できました。診断では音声を再生していません。";
        result["audioBytes"] = bytes.size();
        result["sampleRate"] = pcm.sample_rate;
    } catch (const AudioError& error) {
        if (error.status == 499) throw;
        job.check();
        result["message"] = error.what();
    }
    return result;
}
void Audio::speak(const std::string& text, const Json& settings, std::stop_token stop) {
    check_stop(stop);
    auto job = Impl::begin(impl_);
    std::stop_callback external(stop, [source = job.cancel]() mutable { source.request_stop(); });
    job.check();
    const auto parsed = read_settings(settings);
    std::string selected;
    if (!parsed.device.empty()) {
        const auto available = native_devices();
        selected = audio_detail::resolve_output_device(device_json(available), parsed.device, parsed.label);
    }
    const auto bytes = synthesize_audio(text, parsed, job.cancel.get_token());
    job.check();
    auto pcm = audio_detail::decode_audio(bytes, job.cancel.get_token());
    job.check();
    play(std::move(pcm), selected, parsed.volume, job.cancel.get_token());
    job.check();
}
}
