#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <httplib.h>
#include "spoon/audio.hpp"

#include <atomic>
#include <chrono>
#include <functional>
#include <future>
#include <iostream>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>
#include <vector>

namespace {
using Json = nlohmann::json;
using namespace std::chrono_literals;

void require(bool condition, const char* message) {
    if (!condition) throw std::runtime_error(message); // Active in Release/NDEBUG.
}
template<class Operation>
std::string expect_error(Operation&& operation, int status = 0) {
    try { operation(); }
    catch (const spoon::AudioError& error) {
        require(status == 0 || error.status == status, "Unexpected audio error status");
        return error.what();
    }
    throw std::runtime_error("Expected an AudioError");
}
void append16(std::string& bytes, unsigned value) {
    bytes += static_cast<char>(value & 255);
    bytes += static_cast<char>((value >> 8) & 255);
}
void append32(std::string& bytes, std::uint32_t value) {
    append16(bytes, value & 65535);
    append16(bytes, value >> 16);
}
void set32(std::string& bytes, std::size_t offset, std::uint32_t value) {
    for (unsigned i = 0; i != 4; ++i) bytes.at(offset + i) = static_cast<char>((value >> (8 * i)) & 255);
}
std::string chunk(const char* id, const std::string& bytes) {
    std::string result(id, 4);
    append32(result, static_cast<std::uint32_t>(bytes.size()));
    result += bytes;
    if (bytes.size() & 1) result += '\0';
    return result;
}
std::string wave_format(unsigned tag = 1, unsigned bits = 16, unsigned channels = 1) {
    std::string result;
    append16(result, tag);
    append16(result, channels);
    append32(result, 24000);
    append32(result, 24000 * channels * (bits / 8));
    append16(result, channels * (bits / 8));
    append16(result, bits);
    return result;
}
std::string wave(const std::string& format, const std::string& data, const std::string& extra = {}) {
    std::string contents = "WAVE" + chunk("fmt ", format) + extra + chunk("data", data);
    std::string result = "RIFF";
    append32(result, static_cast<std::uint32_t>(contents.size()));
    return result + contents;
}
std::string test_wave() {
    std::string samples;
    append16(samples, 0);
    append16(samples, 32767);
    append16(samples, 32768);
    return wave(wave_format(), samples);
}

class Loopback {
public:
    httplib::Server server;
    std::thread thread;
    std::string origin;
    ~Loopback() { server.stop(); if (thread.joinable()) thread.join(); }
    void start() {
        const auto port = server.bind_to_any_port("127.0.0.1");
        require(port > 0, "Unable to bind loopback voice server");
        origin = "http://127.0.0.1:" + std::to_string(port);
        thread = std::thread([this] { server.listen_after_bind(); });
        const auto deadline = std::chrono::steady_clock::now() + 3s;
        while (!server.is_running() && std::chrono::steady_clock::now() < deadline) std::this_thread::sleep_for(1ms);
        require(server.is_running(), "Loopback voice server did not start");
    }
};
struct Recorded {
    std::string method, target, text, speaker, body, content_type;
};
class Recording {
    std::mutex mutex;
    std::vector<Recorded> values;
public:
    void add(const httplib::Request& request) {
        std::lock_guard lock(mutex);
        values.push_back({request.method, request.target, request.get_param_value("text"),
            request.get_param_value("speaker"), request.body, request.get_header_value("Content-Type")});
    }
    std::vector<Recorded> get() { std::lock_guard lock(mutex); return values; }
};
Json engine_settings(const Loopback& loop) {
    return {{"provider", "engine"}, {"engineUrl", loop.origin + "/api/"},
        {"systemSpeaker", 42}, {"speed", 1.4}, {"volume", 0.25}};
}
template<class Predicate>
void until(Predicate&& predicate) {
    const auto deadline = std::chrono::steady_clock::now() + 3s;
    while (!predicate() && std::chrono::steady_clock::now() < deadline) std::this_thread::sleep_for(1ms);
    require(predicate(), "Timed out waiting for mock request");
}
void install_success(Loopback& loop, Recording& requests) {
    loop.server.Post("/api/audio_query", [&](const auto& request, auto& response) {
        requests.add(request);
        response.set_content(R"({"accent_phrases":[],"speedScale":1,"volumeScale":0.6})", "application/json; charset=utf-8");
    });
    loop.server.Post("/api/synthesis", [&](const auto& request, auto& response) {
        requests.add(request);
        response.set_content(test_wave(), "audio/wav");
    });
}

void wav_validation() {
    using spoon::audio_detail::parse_wav;
    const auto valid = test_wave();
    const auto pcm = parse_wav(valid);
    require(pcm.sample_rate == 24000 && pcm.channels == 1 && pcm.samples.size() == 3, "Wrong PCM format");
    require(pcm.samples[0] == 0 && pcm.samples[1] == 32767 && pcm.samples[2] == -32768, "Wrong PCM samples");
    require(spoon::audio_detail::decode_audio(valid).samples == pcm.samples, "WAV decoder changed PCM");
    for (const auto& invalid : std::vector<std::string>{"", "RIFF", "not audio", valid.substr(0, valid.size() - 1),
            wave(wave_format(), ""), wave(wave_format(), std::string(1, '\0')),
            wave(wave_format(1, 16, 0), std::string(2, '\0')),
            wave(wave_format(1, 12), std::string(2, '\0')),
            wave(wave_format(2), std::string(2, '\0')),
            wave(wave_format(), std::string(2, '\0'), chunk("fmt ", wave_format())),
            wave(wave_format(), std::string(2, '\0'), chunk("data", std::string(2, '\0')))}) {
        expect_error([&] { parse_wav(invalid); }, 400);
    }
    auto corrupt = valid;
    set32(corrupt, 4, 0xFFFFFFFF);
    expect_error([&] { parse_wav(corrupt); }, 400);
    corrupt = valid;
    set32(corrupt, 16, 0xFFFFFFFF);
    expect_error([&] { parse_wav(corrupt); }, 400);
    corrupt = valid;
    set32(corrupt, 28, 1); // Invalid byte rate.
    expect_error([&] { parse_wav(corrupt); }, 400);
    corrupt = valid + "unexpected trailing bytes";
    expect_error([&] { parse_wav(corrupt); }, 400);
    require(parse_wav(wave(wave_format(), std::string(2, '\0'), chunk("JUNK", "x"))).samples.size() == 1,
            "Odd-sized metadata padding was not handled");
    expect_error([] { spoon::audio_detail::decode_audio(""); }, 400);

    std::string eight;
    eight += '\0'; eight += static_cast<char>(128); eight += static_cast<char>(255);
    const auto pcm8 = parse_wav(wave(wave_format(1, 8), eight));
    require(pcm8.samples == std::vector<std::int16_t>({-32768, 0, 32512}), "Wrong unsigned PCM8 conversion");
    std::string twenty_four("\0\0\x80\xff\xff\x7f", 6);
    require(parse_wav(wave(wave_format(1, 24), twenty_four)).samples == std::vector<std::int16_t>({-32768, 32767}),
            "Wrong PCM24 conversion");
    std::string thirty_two;
    append32(thirty_two, 0x80000000); append32(thirty_two, 0x7FFFFFFF);
    require(parse_wav(wave(wave_format(1, 32), thirty_two)).samples == std::vector<std::int16_t>({-32768, 32767}),
            "Wrong PCM32 conversion");
    std::string floats;
    append32(floats, 0xBF800000); append32(floats, 0); append32(floats, 0x3F800000);
    require(parse_wav(wave(wave_format(3, 32), floats)).samples == std::vector<std::int16_t>({-32767, 0, 32767}),
            "Wrong float PCM conversion");
    append32(floats, 0x7FC00000);
    expect_error([&] { parse_wav(wave(wave_format(3, 32), floats)); }, 400);

    auto extensible = wave_format(0xFFFE);
    append16(extensible, 22); append16(extensible, 16); append32(extensible, 1);
    const unsigned char guid[] = {1, 0, 0, 0, 0, 0, 0x10, 0, 0x80, 0, 0, 0xAA, 0, 0x38, 0x9B, 0x71};
    extensible.append(reinterpret_cast<const char*>(guid), sizeof(guid));
    require(parse_wav(wave(extensible, std::string(2, '\0'))).samples.size() == 1, "Extensible PCM rejected");
    extensible.back() = 0;
    expect_error([&] { parse_wav(wave(extensible, std::string(2, '\0'))); }, 400);

    std::stop_source canceled;
    canceled.request_stop();
    expect_error([&] { parse_wav(valid, canceled.get_token()); }, 499);
    expect_error([&] { spoon::audio_detail::decode_audio(valid, canceled.get_token()); }, 499);
}

void device_resolution() {
    using spoon::audio_detail::resolve_output_device;
    const Json devices = Json::array({{{"id", "a"}, {"name", "Headphones"}},
        {{"id", "b"}, {"name", "Speakers"}}, {{"id", "c"}, {"name", "Speakers"}}});
    require(resolve_output_device(devices, "", "Headphones").empty(), "Label overrode default");
    require(resolve_output_device(devices, "b", "Headphones") == "b", "Existing ID was not preferred");
    require(resolve_output_device(devices, "old-id", "Headphones") == "a", "Unique legacy label did not migrate");
    expect_error([&] { resolve_output_device(devices, "old-id", "Speakers"); }, 400);
    expect_error([&] { resolve_output_device(devices, "old-id", ""); }, 400);
    expect_error([&] { resolve_output_device(devices, "old-id", "Disconnected output"); }, 400);
    expect_error([&] { resolve_output_device(Json::array(), "old-id", "Headphones"); }, 400);
    expect_error([&] { resolve_output_device(Json::array({Json{{"id", "x"}}}), "old-id", "Headphones"); }, 400);
    const Json full_names = Json::array({{{"id", "winmm:device"}, {"name", "Voicemeeter Input (VB-Audio Voicemeeter VAIO)"},
        {"legacyName", "Voicemeeter Input (VB-Audio Voi"}, {"endpointId", "endpoint-id"}}});
    require(resolve_output_device(full_names, "old-id", "Voicemeeter Input (VB-Audio Voi") == "winmm:device", "Truncated legacy label did not migrate");
    require(resolve_output_device(full_names, "wasapi:endpoint-id", "old name") == "winmm:device", "Endpoint identity did not migrate");
    require(resolve_output_device(full_names, "endpoint-id", "") == "winmm:device", "Bare endpoint identity did not migrate");
}

void speech_diagnostics() {
    Loopback loop;
    Recording requests;
    install_success(loop, requests);
    loop.start();
    spoon::Audio audio;
    auto settings = engine_settings(loop);
    settings["outputDeviceId"] = "disconnected-output";
    const auto result = audio.diagnose(settings);
    require(result["ok"] == true && result["requests"].size() == 2, "Diagnosis failed with a disconnected output");
    require(result["requests"][0]["stage"] == "audio_query" && result["requests"][0]["status"] == 200 &&
        result["requests"][1]["stage"] == "synthesis" && result["requests"][1]["status"] == 200, "Diagnosis did not report actual HTTP results");
    require(result["sampleRate"] == 24000 && result["audioBytes"] == test_wave().size(), "Diagnosis did not validate returned audio");
    const auto missing_key = audio.diagnose({{"provider", "legacy"}, {"apiKey", ""}});
    require(missing_key["ok"] == false && missing_key["requests"].empty(), "Missing API key reached the network");
    std::stop_source canceled;
    canceled.request_stop();
    expect_error([&] { audio.diagnose(settings, canceled.get_token()); }, 499);
    Loopback failing;
    failing.server.Post("/api/audio_query", [](const auto&, auto& response) {
        response.status = 429; response.set_content("private-diagnostic-secret", "text/plain");
    });
    failing.start();
    const auto limited = audio.diagnose(engine_settings(failing));
    require(limited["ok"] == false && limited["requests"].size() == 1 && limited["requests"][0]["status"] == 429, "Diagnostic lost error status or retried rate limit");
    require(limited.dump().find("private-diagnostic-secret") == std::string::npos, "Diagnostic leaked server content");
}

void request_formatting() {
    Loopback loop;
    Recording requests;
    install_success(loop, requests);
    loop.start();
    spoon::Audio audio;
    // UTF-8 bytes keep this test independent of the compiler source code page.
    const std::string text = "hello + & =/" "\xE6\x97\xA5\xE6\x9C\xAC\xE8\xAA\x9E";
    require(audio.synthesize(text, engine_settings(loop)) == test_wave(), "Wrong synthesis bytes");
    const auto seen = requests.get();
    require(seen.size() == 2, "Expected exactly two engine requests");
    require(seen[0].method == "POST" && seen[0].body.empty(), "Wrong audio_query method/body");
    require(seen[0].target.starts_with("/api/audio_query?text=hello+%2B+%26+%3D%2F"), "Text was not URL encoded");
    require(seen[0].text == text && seen[0].speaker == "42", "Wrong query text/speaker");
    require(seen[1].method == "POST" && seen[1].target == "/api/synthesis?speaker=42", "Wrong synthesis endpoint");
    require(seen[1].content_type == "application/json", "Wrong synthesis content type");
    const auto query = Json::parse(seen[1].body);
    require(query["speedScale"] == 1.4 && query["volumeScale"] == 0.6 && query["accent_phrases"].is_array(),
            "Audio query fields were not preserved/speedScale was not replaced");

    const auto legacy = spoon::audio_detail::legacy_request(text,
        {{"provider", "legacy"}, {"apiKey", "key +&=secret"}, {"systemSpeaker", 13}, {"speed", 1.4}});
    require(legacy.method == "POST", "Wrong hosted method");
    require(legacy.url == "https://deprecatedapis.tts.quest/v2/voicevox/audio/?speaker=13&pitch=0&intonationScale=1&speed=1.4",
            "Wrong hosted query parameters");
    require(legacy.url.find("secret") == std::string::npos && legacy.url.find("key=") == std::string::npos,
            "Hosted key leaked into URL");
    require(legacy.headers.at("Content-Type") == "application/x-www-form-urlencoded; charset=UTF-8", "Wrong hosted form content type");
    require(legacy.body == "text=hello+%2B+%26+%3D%2F%E6%97%A5%E6%9C%AC%E8%AA%9E&key=key+%2B%26%3Dsecret", "Wrong hosted form encoding");
}

void cancel_before_fetch() {
    Loopback loop;
    Recording requests;
    install_success(loop, requests);
    loop.start();
    spoon::Audio audio;
    std::stop_source canceled;
    canceled.request_stop();
    const auto settings = engine_settings(loop);
    expect_error([&] { audio.synthesize("never fetched", settings, canceled.get_token()); }, 499);
    expect_error([&] { audio.speak("never played", settings, canceled.get_token()); }, 499);
    require(requests.get().empty(), "Pre-canceled work reached the server");
    audio.stop();
    require(audio.synthesize("new job after stop", settings) == test_wave(), "stop() canceled a future job");
}

void coeiroink_direct_routing() {
    Loopback primary, direct;
    Recording primary_requests, direct_requests;
    install_success(primary, primary_requests);
    direct.server.Post("/api/v1/synthesis", [&](const auto& request, auto& response) {
        direct_requests.add(request); response.set_content(test_wave(), "audio/wav");
    });
    primary.start(); direct.start();
    spoon::Audio audio;
    auto settings = engine_settings(primary);
    settings["coeiroinkDirectEnabled"] = true;
    settings["coeiroinkDirectUrl"] = direct.origin + "/api/";
    settings["systemSpeaker"] = "coeiroink:cb11bdbd-78fc-4f16-b528-a400bae1782d:90";
    settings["provider"] = "legacy"; settings["apiKey"] = "";
    require(audio.synthesize("Direct + 日本語", settings) == test_wave(), "Direct COEIROINK synthesis failed");
    require(primary_requests.get().empty(), "Direct COEIROINK reached the VOICEVOX engine");
    const auto seen = direct_requests.get();
    require(seen.size() == 1 && seen[0].target == "/api/v1/synthesis" && seen[0].content_type == "application/json", "Direct API used the wrong endpoint or format");
    const auto body = Json::parse(seen[0].body);
    require(body["speakerUuid"] == "cb11bdbd-78fc-4f16-b528-a400bae1782d" && body["styleId"] == 90 && body["text"] == "Direct + 日本語", "Direct API lost the UUID, style or text");
    require(body["speedScale"] == 1.4 && body["volumeScale"] == 1.0 && body["outputSamplingRate"] == 44100, "Direct API speed/volume/sample rate was incorrect");
    settings["coeiroinkEnabled"] = true;
    expect_error([&] { audio.synthesize("mutually exclusive", settings); }, 400);
    require(direct_requests.get().size() == 1, "Conflicting modes reached the API");
}

void coeiroink_bridge_routing() {
    Loopback primary, bridge;
    Recording primary_requests, bridge_requests;
    install_success(primary, primary_requests);
    install_success(bridge, bridge_requests);
    primary.start(); bridge.start();
    spoon::Audio audio;
    auto settings = engine_settings(primary);
    settings["coeiroinkEnabled"] = true;
    settings["coeiroinkUrl"] = bridge.origin + "/api/";
    settings["systemSpeaker"] = "coeiroink:cb11bdbd-78fc-4f16-b528-a400bae1782d:90";
    require(audio.synthesize("bridge", settings) == test_wave(), "Bridge synthesis failed");
    require(primary_requests.get().empty(), "COEIROINK request reached the primary engine");
    const auto seen = bridge_requests.get();
    require(seen.size() == 2 && seen[0].speaker == "90" && seen[1].target == "/api/synthesis?speaker=90", "Bridge style was not routed correctly");
    require(Json::parse(seen[1].body)["speedScale"] == 1.4, "Bridge speed setting was lost");
    settings["provider"] = "legacy"; settings["apiKey"] = "";
    require(audio.synthesize("bridge without hosted key", settings) == test_wave(), "Bridge required a hosted API key");
    settings["provider"] = "engine"; settings["coeiroinkEnabled"] = false;
    require(audio.synthesize("disabled", settings) == test_wave(), "Disabled bridge did not fall back to primary");
    require(bridge_requests.get().size() == 4 && primary_requests.get().size() == 2, "Disabled bridge still received requests");
    // The real bridge streams without a Content-Type header. httplib's fixed
    // body response adds text/plain by default, so use its streaming provider.
    bridge.server.Post("/headerless/audio_query", [](const auto&, auto& response) {
        response.set_content(R"({"accent_phrases":[]})", "application/json");
    });
    bridge.server.Post("/headerless/synthesis", [](const auto&, auto& response) {
        response.set_chunked_content_provider("", [](std::size_t, httplib::DataSink& sink) {
            const auto wav = test_wave(); sink.write(wav.data(), wav.size()); sink.done(); return true;
        });
    });
    settings["coeiroinkEnabled"] = true; settings["coeiroinkUrl"] = bridge.origin + "/headerless";
    require(audio.diagnose(settings)["ok"] == true, "Headerless bridge WAV failed validation");
    settings["coeiroinkEnabled"] = true;
    settings["systemSpeaker"] = "coeiroink:bad-uuid:90";
    expect_error([&] { audio.synthesize("invalid", settings); }, 400);
}

void url_validation() {
    Loopback loop;
    Recording requests;
    install_success(loop, requests);
    loop.start();
    spoon::Audio audio;
    for (const auto& suffix : {"?secret=yes", "#fragment"}) {
        auto settings = engine_settings(loop);
        settings["engineUrl"] = loop.origin + suffix;
        expect_error([&] { audio.synthesize("test", settings); }, 400);
    }
    for (const std::string& url : {"https://user:secret@example.invalid/", "https://@example.invalid/", "file:///secret",
            "ftp://example.invalid/", "http://", " http://localhost/", "http://localhost/\r\nsecret", "http://localhost\\secret"}) {
        auto settings = engine_settings(loop);
        settings["engineUrl"] = url;
        const auto message = expect_error([&] { audio.synthesize("test", settings); }, 400);
        require(message.find("secret") == std::string::npos && message.find(url) == std::string::npos, "Invalid URL leaked into error");
    }
    require(requests.get().empty(), "Invalid URL reached the server");
    expect_error([&] { audio.synthesize("test", {{"provider", "legacy"}, {"apiKey", ""}}); }, 400);
    expect_error([&] { audio.synthesize("test", {{"provider", "unknown"}}); }, 400);
}

void retry_statuses() {
    for (int status : {500, 502, 503, 504, 400, 401, 403, 429, 501, 505}) {
        Loopback loop;
        std::atomic<int> queries{0}, synthesis{0};
        loop.server.Post("/api/audio_query", [&](const auto&, auto& response) {
            if (++queries == 1) { response.status = status; response.set_content("untrusted server body", "text/plain"); }
            else response.set_content("{}", "application/json");
        });
        loop.server.Post("/api/synthesis", [&](const auto&, auto& response) {
            ++synthesis;
            response.set_content(test_wave(), "audio/wav");
        });
        loop.start();
        spoon::Audio audio;
        const auto start = std::chrono::steady_clock::now();
        const bool retries = status == 500 || status == 502 || status == 503 || status == 504;
        if (retries) {
            require(audio.synthesize("test", engine_settings(loop)) == test_wave(), "Transient status did not retry");
            require(queries == 2 && synthesis == 1, "Wrong number of retry requests");
            require(std::chrono::steady_clock::now() - start >= 950ms, "Retry did not wait one second");
        } else {
            expect_error([&] { audio.synthesize("test", engine_settings(loop)); }, status);
            require(queries == 1 && synthesis == 0, "Non-transient status was retried");
        }
    }
    Loopback loop;
    std::atomic<int> queries{0}, synthesis{0};
    loop.server.Post("/api/audio_query", [&](const auto&, auto& response) {
        ++queries; response.set_content("{}", "application/json");
    });
    loop.server.Post("/api/synthesis", [&](const auto&, auto& response) {
        ++synthesis; response.status = 503;
        response.set_content("https://secret.example/?key=private-key raw server text", "text/plain");
    });
    loop.start();
    spoon::Audio audio;
    const auto message = expect_error([&] { audio.synthesize("test", engine_settings(loop)); }, 503);
    require(queries == 2 && synthesis == 2, "Synthesis must retry the operation exactly once");
    require(message.find("private-key") == std::string::npos && message.find("secret.example") == std::string::npos &&
        message.find("raw server text") == std::string::npos, "Server details leaked into error");
}

void response_validation() {
    // Successful HTTP status does not make error JSON or an empty body audio.
    for (const auto& scenario : {"bad-json", "array-query", "wrong-query-type", "empty-audio", "json-audio", "invalid-key", "no-points"}) {
        Loopback loop;
        std::atomic<int> queries{0}, synthesis{0};
        const std::string mode = scenario;
        loop.server.Post("/api/audio_query", [&](const auto&, auto& response) {
            ++queries;
            if (mode == "bad-json") response.set_content("raw-server-secret", "application/json");
            else if (mode == "array-query") response.set_content("[]", "application/json");
            else if (mode == "wrong-query-type") response.set_content("{}", "text/html");
            else response.set_content("{}", "application/json");
        });
        loop.server.Post("/api/synthesis", [&](const auto&, auto& response) {
            ++synthesis;
            if (mode == "empty-audio") response.set_content("", "audio/wav");
            else if (mode == "json-audio") response.set_content("{\"message\":\"raw-server-secret\"}", "application/json");
            else if (mode == "invalid-key") {
                response.status = 500;
                response.set_content("{\"error\":\"invalidApiKey\",\"detail\":\"raw-server-secret\"}", "application/json");
            } else if (mode == "no-points") response.set_content("{\"code\":\"notEnoughPoints\"}", "application/json");
            else response.set_content(test_wave(), "audio/wav");
        });
        loop.start();
        spoon::Audio audio;
        const auto message = expect_error([&] { audio.synthesize("test", engine_settings(loop)); });
        require(queries == 1 && synthesis <= 1, "Malformed response or key/point error was retried");
        require(message.find("raw-server-secret") == std::string::npos, "Raw response escaped into error");
    }
}

void cancellation_and_replacement() {
    for (bool external : {false, true}) {
        Loopback loop;
        std::atomic<int> queries{0};
        loop.server.Post("/api/audio_query", [&](const auto&, auto& response) {
            ++queries; response.status = 503; response.set_content("retry", "text/plain");
        });
        loop.start();
        spoon::Audio audio;
        std::stop_source source;
        auto pending = std::async(std::launch::async, [&] {
            return expect_error([&] { audio.synthesize("cancel retry", engine_settings(loop), source.get_token()); }, 499);
        });
        until([&] { return queries.load() == 1; });
        // Give the response time to enter the interruptible retry delay.
        std::this_thread::sleep_for(50ms);
        const auto start = std::chrono::steady_clock::now();
        if (external) source.request_stop(); else audio.stop();
        require(pending.wait_for(500ms) == std::future_status::ready, "Cancellation did not interrupt retry promptly");
        pending.get();
        require(std::chrono::steady_clock::now() - start < 500ms && queries == 1, "Canceled work retried");
    }
    Loopback loop;
    std::atomic<int> old_queries{0}, new_queries{0};
    loop.server.Post("/api/audio_query", [&](const auto& request, auto& response) {
        if (request.get_param_value("text") == "old") {
            ++old_queries; response.status = 503; response.set_content("retry", "text/plain");
        } else { ++new_queries; response.set_content("{}", "application/json"); }
    });
    loop.server.Post("/api/synthesis", [&](const auto&, auto& response) { response.set_content(test_wave(), "audio/wav"); });
    loop.start();
    spoon::Audio audio;
    auto old = std::async(std::launch::async, [&] {
        return expect_error([&] { audio.synthesize("old", engine_settings(loop)); }, 499);
    });
    until([&] { return old_queries.load() == 1; });
    require(audio.synthesize("new", engine_settings(loop)) == test_wave(), "Replacement job failed");
    require(old.wait_for(500ms) == std::future_status::ready, "Replacement did not cancel old job");
    old.get();
    require(old_queries == 1 && new_queries == 1, "Replaced job performed more requests");
}
}

int main() {
    // These tests never open waveOut or play sound. speak() is called only with
    // a pre-canceled token; all network tests call the fetch-only synthesize().
    const std::vector<std::pair<const char*, std::function<void()>>> tests = {
        {"WAV validation and conversion", wav_validation},
        {"Device selection and legacy migration", device_resolution},
        {"Speech diagnosis without playback", speech_diagnostics},
        {"VOICEVOX and hosted request formatting", request_formatting},
        {"Optional COEIROINK bridge routing", coeiroink_bridge_routing},
        {"Direct COEIROINK API routing and exclusion", coeiroink_direct_routing},
        {"Cancellation before fetch", cancel_before_fetch},
        {"Engine URL validation", url_validation},
        {"Exact transient-status retry policy", retry_statuses},
        {"Safe response validation", response_validation},
        {"Interruptible cancellation and replacement", cancellation_and_replacement},
    };
    unsigned failed = 0;
    for (const auto& [name, test] : tests) {
        try { test(); std::cout << "PASS: " << name << '\n'; }
        catch (const std::exception& error) { ++failed; std::cerr << "FAIL: " << name << ": " << error.what() << '\n'; }
    }
    return failed ? 1 : 0;
}
