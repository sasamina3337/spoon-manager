#pragma once

#include <cstdint>
#include <map>
#include <memory>
#include <stdexcept>
#include <stop_token>
#include <string>
#include <string_view>
#include <vector>
#include <nlohmann/json.hpp>

namespace spoon {

// Errors contain only local messages, never response text, URLs, or API keys.
class AudioError : public std::runtime_error {
public:
    AudioError(int status, const char* message) : std::runtime_error(message), status(status) {}
    const int status;
};

class Audio {
public:
    Audio();
    ~Audio();
    Audio(const Audio&) = delete;
    Audio& operator=(const Audio&) = delete;

    nlohmann::json devices() const;
    // Synchronous: run on a worker. Starting a job cancels the previous job.
    // Empty outputDeviceId selects the Windows default. A stale nonempty ID
    // can migrate only through an exactly matching, unique outputDeviceLabel.
    void speak(const std::string& text, const nlohmann::json& settings,
               std::stop_token stop = {});
    void stop();
    // Fetches encoded audio without opening an output device (also canceled by stop()).
    std::string synthesize(const std::string& text, const nlohmann::json& settings,
                           std::stop_token stop = {});
    // Fixed short synthesis/decoding check. Does not open an output device.
    nlohmann::json diagnose(const nlohmann::json& settings, std::stop_token stop = {});

private:
    struct Impl;
    std::shared_ptr<Impl> impl_;
};

// Deterministic helpers permit format/routing/request tests without making sound.
namespace audio_detail {
struct PcmAudio {
    std::uint32_t sample_rate = 0;
    std::uint16_t channels = 0;
    std::vector<std::int16_t> samples; // interleaved signed 16-bit PCM
};
struct SpeechRequest {
    std::string method, url;
    std::map<std::string, std::string> headers;
    std::string body;
};

// Strict RIFF/WAVE parser: integer PCM (8/16/24/32 bit) and 32-bit IEEE float,
// including their WAVE_FORMAT_EXTENSIBLE variants. Rejects empty/truncated audio.
PcmAudio parse_wav(std::string_view bytes, std::stop_token stop = {});
// WAV uses the strict parser; other containers (including MP3) use installed
// Windows Media Foundation decoders. No network access or audio playback.
PcmAudio decode_audio(std::string_view bytes, std::stop_token stop = {});
std::string resolve_output_device(const nlohmann::json& devices,
                                 const std::string& id, const std::string& label);
SpeechRequest legacy_request(const std::string& text, const nlohmann::json& settings);
}
}
