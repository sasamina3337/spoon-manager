#include "spoon/model.hpp"

#include <chrono>
#include <cmath>
#include <exception>
#include <iostream>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace {

using spoon::Json;
using spoon::Model;

// These checks remain enabled when the test target defines NDEBUG.
void check(bool condition, const std::string& message) {
    if (!condition) throw std::runtime_error(message);
}

template<class Action>
void rejects(Action action, const std::string& message) {
    bool rejected = false;
    try { action(); } catch (const std::invalid_argument&) { rejected = true; }
    check(rejected, message);
}

std::int64_t utc(int year, unsigned month, unsigned day, int hour = 0, int minute = 0, int second = 0) {
    using namespace std::chrono;
    return duration_cast<milliseconds>(sys_days{year_month_day{std::chrono::year{year},
        std::chrono::month{month}, std::chrono::day{day}}}.time_since_epoch()).count()
        + ((hour * 60LL + minute) * 60 + second) * 1000;
}

Json person(std::string id = "api:dj:a", std::string name = "リスナー") {
    return {{"id", std::move(id)}, {"name", std::move(name)}};
}

Json event(std::string id, std::string type = "comment", Json amount = nullptr,
           Json user = person(), std::string time = "2026-11-06T15:00:00Z") {
    Json result = {{"id", std::move(id)}, {"type", std::move(type)}, {"user", std::move(user)},
        {"text", "同じ内容"}, {"time", std::move(time)}};
    if (!amount.is_null()) result["amount"] = std::move(amount);
    return result;
}

Json saved_session(std::string key = "api:dj:1") {
    return {{"key", std::move(key)}, {"live", {{"liveId", 1}, {"title", "配信"}}},
        {"observedAt", "2026-11-06T10:00:00Z"}, {"updatedAt", "2026-11-06T10:30:00Z"},
        {"endedAt", "2026-11-06T10:30:00Z"}, {"users", Json::array()}, {"events", Json::array()},
        {"seen", Json::array()}, {"totals", {{"comments", 0}, {"entries", 0}, {"hearts", 0}, {"spoons", 0}, {"follows", 0}}},
        {"requests", {{"open", false}, {"items", Json::array()}}}};
}

const Json& find_session(const Json& state, const std::string& key) {
    for (const auto& saved : state.at("manager").at("sessions")) if (saved.at("key") == key) return saved;
    throw std::runtime_error("Missing session " + key);
}

// A CSV reader verifies actual field boundaries, embedded quotes/newlines,
// UTF-8 bytes and row sizes instead of matching implementation substrings.
std::vector<std::vector<std::string>> read_csv(const std::string& csv) {
    check(csv.starts_with("\xef\xbb\xbf"), "CSV needs a UTF-8 BOM");
    std::vector<std::vector<std::string>> rows;
    std::size_t pos = 3;
    while (pos < csv.size()) {
        std::vector<std::string> row;
        bool more = true;
        while (more) {
            check(pos < csv.size() && csv[pos++] == '"', "Every CSV cell is quoted");
            std::string cell;
            bool closed = false;
            while (pos < csv.size()) {
                const char c = csv[pos++];
                if (c != '"') cell += c;
                else if (pos < csv.size() && csv[pos] == '"') { cell += '"'; ++pos; }
                else { closed = true; break; }
            }
            check(closed, "CSV cell must close");
            row.push_back(std::move(cell));
            more = pos < csv.size() && csv[pos] == ',';
            if (more) ++pos;
        }
        rows.push_back(std::move(row));
        if (pos < csv.size()) {
            check(csv.substr(pos, 2) == "\r\n", "CSV uses CRLF row separators");
            pos += 2;
        }
    }
    return rows;
}

void fixture_and_settings() {
    // Same envelope written by desktop storage.local / the old native Store.
    // All opaque extensions must survive load, mutation and a JSON round trip.
    const Json fixture = Json::parse(R"json({
      "settings":{"schemaVersion":1,"enabled":false,"provider":"engine",
        "apiKey":"saved-key","eventEnabled":{"comment":true,"futureEvent":false},
        "commentSpeakers":[2,3],"futureSetting":{"mode":"keep"}},
      "voices":[{"id":2,"name":"声","futureVoice":7}],
      "assignments":{"users":[{"id":"api:dj:a","speaker":2}],"futureAssignment":true},
      "futureRoot":{"opaque":[1,null,{"x":2}]},
      "manager":{
        "preferences":{"heartGoal":300,"spoonGoal":100,"futurePreference":"keep"},
        "playroom":{"profiles":[{"id":"api:dj:a","fortune":{"date":"2026-11-07","result":"大吉"},
            "reversi":{"board":[0,1,-1],"futurePosition":true},"counters":{"reversiPlayed":9}}],"futurePlayroom":8},
        "futureManager":{"keep":true},
        "sessions":[{"key":"api:dj:123","source":"api","live":{"liveId":123,"title":"旧配信","futureLive":42},
          "observedAt":"2026-11-06T14:00:00.000Z","updatedAt":"2026-11-06T14:30:00.000Z","endedAt":null,
          "users":[{"id":"api:dj:a","name":"名前","firstSeen":"2026-11-06T14:00:00.000Z","lastSeen":"2026-11-06T14:30:00.000Z",
            "comments":11,"entries":2,"hearts":30,"spoons":200,"follows":1,"subscription":{"plan":"VIP","futurePlan":7},
            "visits":{"2026-11-06":{"firstSeen":"2026-11-06T14:00:00.000Z","lastSeen":"2026-11-06T14:30:00.000Z","entries":2,"futureVisit":true}},
            "futureUser":{"color":"blue"}}],
          "events":[{"id":"retained","type":"comment","user":{"id":"api:dj:a","name":"名前"},"text":"以前","time":"2026-11-06T14:01:00Z","amount":1,"isDj":false,"futureEvent":12}],
          "seen":["retained","trimmed-but-seen"],"totals":{"comments":11,"entries":2,"hearts":30,"spoons":200,"follows":1,"futureTotal":44},
          "requests":{"open":true,"items":[{"id":1,"eventId":"request-1","kind":"question","status":"working","text":"質問","user":{"id":"api:dj:a","name":"名前"},"futureRequest":true}],"futureInbox":3},
          "poll":{"open":true,"question":"投票","votes":{"api:dj:a":1},"futurePoll":4},
          "donationHistory":{"items":[{"amount":7,"stickerName":"ギフト","futureDonation":true}],"total":7,"fetchedAt":"2026-11-06T14:00:00Z","futureHistory":5},
          "futureSession":{"keep":[1,2,3]}}]
      }
    })json");
    std::int64_t now = utc(2026, 11, 7);
    Model model(fixture, [&] { return now; });
    check(model.snapshot() == fixture, "Existing complete state must round-trip without rewriting opaque fields");
    auto detached = model.snapshot();
    detached["manager"]["sessions"].clear();
    check(model.snapshot() == fixture, "snapshot is an independent value");
    model.set_settings({{"enabled", true}, {"eventEnabled", {{"comment", false}}},
        {"commentSpeakers", Json::array({5})}, {"explicitNull", nullptr}});
    const auto patched = model.snapshot();
    check(patched["settings"]["eventEnabled"] == Json({{"comment", false}, {"futureEvent", false}}), "Nested unknown settings survive patches");
    check(patched["settings"]["commentSpeakers"] == Json::array({5}), "Array settings replace instead of merging indices");
    check(patched["settings"]["explicitNull"].is_null(), "Null settings are retained explicitly");
    check(patched["settings"]["apiKey"] == "saved-key", "Unmentioned settings survive");
    rejects([&] { model.set_settings(Json::array()); }, "Non-object settings must be rejected");
    check(model.snapshot() == patched, "Rejected settings patches are atomic");
    check(!model.record("api:dj:123", event("trimmed-but-seen")), "Seen IDs survive beyond retained logs");
    model.begin_session("api:dj:123", {{"liveId", 123}, {"title", "新配信"}, {"accessToken", "never-store"}, {"connection", {{"secret", "never-store"}}}});
    model.record("api:dj:123", event("new"));
    const auto changed = model.snapshot();
    const auto& saved = find_session(changed, "api:dj:123");
    check(saved["live"]["futureLive"] == 42 && !saved["live"].contains("accessToken") && !saved["live"].contains("connection"), "Live update keeps saved extensions but whitelists incoming fields");
    check(saved["users"][0]["futureUser"] == fixture["manager"]["sessions"][0]["users"][0]["futureUser"], "User extensions survive activity");
    check(saved["totals"]["futureTotal"] == 44 && saved["totals"]["comments"] == 12, "Totals extensions survive incrementing");
    check(saved["events"][0]["futureEvent"] == 12 && saved["futureSession"]["keep"].size() == 3, "Retained events and session extensions survive");
    check(changed["voices"] == fixture["voices"] && changed["assignments"] == fixture["assignments"] && changed["futureRoot"] == fixture["futureRoot"], "Other persistence branches survive");
    check(changed["manager"]["playroom"] == fixture["manager"]["playroom"], "Saved game data is preserved opaquely");
    model.finish_session("api:dj:123");
    const auto finished_state = model.snapshot();
    const auto& finished = find_session(finished_state, "api:dj:123");
    check(!finished["poll"]["open"].get<bool>() && !finished["requests"]["open"].get<bool>(), "Ending closes poll and requests");
    check(finished["poll"]["futurePoll"] == 4 && finished["requests"]["items"][0]["status"] == "working", "Ending retains votes and request contents");
    Model restored(Json::parse(finished_state.dump()), [&] { return now; });
    check(restored.snapshot() == finished_state, "Modified legacy state survives serialization and restoration");
    check(!restored.record("api:dj:123", event("new")), "Deduplication survives restart");
}

void counting_and_lifecycle() {
    std::int64_t now = utc(2026, 11, 6, 15);
    Model model(Json::object(), [&] { return now; });
    check(!model.record("missing", event("missing")), "Unknown session does not accept events");
    model.observe("missing", Json::array({person()}));
    model.finish_session("missing");
    rejects([&] { model.begin_session("", Json::object()); }, "Empty session key is rejected");
    model.begin_session("api:dj:1", {{"liveId", 1}, {"title", "配信"}, {"listenerCount", 5}, {"tags", Json::array({"a", 7, nullptr})}, {"token", "private"}});
    model.observe("api:dj:1", Json::array({person(), person("api:dj:b"), person("api:dj:dj", "DJ"), nullptr, {{"id", "invalid"}}}));
    auto first = event("1");
    check(model.record("api:dj:1", first), "First comment accepted");
    check(!model.record("api:dj:1", first), "Repeated event ID is ignored");
    auto duplicate_snapshot = model.snapshot();
    now += 1000;
    first["text"] = "changed payload";
    check(!model.record("api:dj:1", first) && model.snapshot() == duplicate_snapshot, "Duplicate does not mutate user, totals or timestamps");
    for (const auto& item : {event("2"), event("3", "entry"), event("4", "entry"), event("5", "heart", 30), event("6", "spoon", 300), event("7", "follow")})
        check(model.record("api:dj:1", item), "Distinct event accepted despite identical text");
    auto dj = event("8", "comment", 1, person("api:dj:dj", "DJ"));
    dj["isDj"] = true;
    model.record("api:dj:1", dj);
    model.record("api:dj:1", event("unknown-heart", "heart"));
    auto unknown_spoon = event("unknown-spoon", "spoon");
    unknown_spoon["amount"] = nullptr;
    model.record("api:dj:1", unknown_spoon);
    model.record("api:dj:1", event("zero", "heart", 0));
    model.record("api:dj:1", event("negative", "spoon", -100));
    model.record("api:dj:1", event("string-number", "spoon", " 12.5 "));
    model.record("api:dj:1", event("invalid-number", "spoon", "bad"));
    model.record("api:dj:1", event("without-user", "comment", nullptr, nullptr));
    model.record("api:dj:1", event("temperature", "temperature", 45));
    check(!model.record("api:dj:1", {{"type", "comment"}}), "Missing IDs are rejected without poisoning deduplication");
    check(!model.record("api:dj:1", {{"id", ""}, {"type", "comment"}}), "Empty IDs are rejected");
    check(!model.record("api:dj:1", {{"id", 42}, {"type", "comment"}}), "Event IDs must be strings");
    auto state = model.snapshot();
    const auto& saved = find_session(state, "api:dj:1");
    check(saved["totals"] == Json({{"comments", 3}, {"entries", 2}, {"hearts", 30}, {"spoons", 312.5}, {"follows", 1}}), "Totals use quantities; exclude DJ comments; accept unattributed activity");
    check(saved["users"].size() == 3 && saved["users"][0]["comments"] == 2, "Participants use IDs, preserving same names and independent user totals");
    check(saved["quantityUnknown"] == Json({{"hearts", 1}, {"spoons", 1}}) && saved["users"][0]["quantityUnknown"] == saved["quantityUnknown"], "Unknown quantities count notifications separately");
    check(!saved["users"][2].contains("visits") || saved["users"][2]["visits"].empty(), "DJ is excluded from attendance even when observed");
    check(saved["events"][8]["amount"].is_null() && saved["events"][10]["amount"] == 0, "Unknown gift quantity differs from explicit zero");
    check(saved["live"]["tags"] == Json::array({"a", "7", "null"}) && !saved["live"].contains("token"), "Live tag normalization and token filtering");
    check(saved["observedAt"] == "2026-11-06T15:00:00.000Z", "Creation uses injected UTC clock");
    model.finish_session("api:dj:1");
    state = model.snapshot();
    check(find_session(state, "api:dj:1")["endedAt"] == "2026-11-06T15:00:01.000Z", "Finish timestamps persist");
    now += 1000;
    model.begin_session("api:dj:1", {{"liveId", 1}, {"title", "resume"}});
    state = model.snapshot();
    const auto& resumed = find_session(state, "api:dj:1");
    check(resumed["endedAt"].is_null() && resumed["observedAt"] == "2026-11-06T15:00:00.000Z" && resumed["totals"]["comments"] == 3, "Resume retains original counts and observation time");
    check(state["manager"]["sessions"].size() == 1, "Resume does not duplicate sessions");
    model.begin_session("api:dj:2", {{"liveId", 2}});
    state = model.snapshot();
    check(find_session(state, "api:dj:2")["totals"]["comments"] == 0, "New broadcast starts at zero");
    check(!state.contains("activeKey") && !state["manager"].contains("activeKey"), "Active selection is transient");
}

void manager_preferences() {
    const Json previous = {{"heartGoal", 300}, {"futurePreference", "keep"},
        {"features", {{"futureScope", false}}}, {"commands", {{"futureCommand", 42}}}};
    Model model({{"manager", {{"preferences", previous}}}});
    model.set_preferences({{"spoonGoal", "500"}, {"features", {{"fans", true}}},
        {"commands", {{"cooldownSeconds", 1}}}, {"templates", Json::array({{{"label", "  案内  "}, {"text", " hello\nworld "}, {"futureTemplate", 7}}})}});
    auto state = model.snapshot();
    const auto& prefs = state["manager"]["preferences"];
    check(prefs["heartGoal"] == 300 && prefs["spoonGoal"] == 500 && prefs["futurePreference"] == "keep", "Preference patches normalize goals and preserve extensions");
    check(prefs["features"]["fans"] == true && prefs["features"]["chat"] == false && prefs["features"]["futureScope"] == false, "Features default to no additional scopes and preserve unknown flags");
    check(prefs["commands"]["cooldownSeconds"] == 10 && prefs["commands"]["futureCommand"] == 42, "Command cooldown has minimum 10 seconds");
    check(prefs["templates"][0]["label"] == "案内" && prefs["templates"][0]["text"] == "hello\nworld" && prefs["templates"][0]["futureTemplate"] == 7, "Templates trim and preserve unknown properties");
    for (const auto& patch : {Json({{"heartGoal", -1}}), Json({{"spoonGoal", 1.2}}), Json({{"heartGoal", "invalid"}}),
            Json({{"heartGoal", 1000000001}}), Json({{"templates", Json::array({{{"label", "x"}, {"text", " "}}})}})}) {
        rejects([&] { model.set_preferences(patch); }, "Invalid goals and templates must be rejected");
        check(model.snapshot() == state, "Rejected preferences do not partially mutate saved settings");
    }
    std::string emoji;
    for (int i = 0; i < 101; ++i) emoji += "😀";
    rejects([&] { model.set_preferences({{"templates", Json::array({{{"label", "x"}, {"text", emoji}}})}}); }, "Template length uses UTF-16 units for emoji");
    auto too_many = Json::array();
    for (int i = 0; i < 9; ++i) too_many.push_back({{"label", "x"}, {"text", "y"}});
    rejects([&] { model.set_preferences({{"templates", too_many}}); }, "At most eight templates");
    model.set_preferences({{"commands", {{"cooldownSeconds", 500}}}, {"heartGoal", 0}});
    state = model.snapshot();
    check(state["manager"]["preferences"]["commands"]["cooldownSeconds"] == 120 && state["manager"]["preferences"]["heartGoal"] == 0, "Maximum cooldown and zero goals");
}

void retention() {
    const auto now = utc(2026, 11, 7);
    Model model(Json::object(), [=] { return now; });
    model.begin_session("api:dj:1", {{"liveId", 1}});
    for (int i = 0; i < 10020; ++i) check(model.record("api:dj:1", event(std::to_string(i))), "Fresh events must be accepted");
    auto state = model.snapshot();
    const auto& saved = find_session(state, "api:dj:1");
    check(saved["events"].size() == 10000 && saved["events"][0]["id"] == "20", "Rolling log retains the newest 10000 events");
    check(saved["totals"]["comments"] == 10020 && saved["users"][0]["comments"] == 10020, "Lifetime totals outlive log truncation");
    Model restarted(state, [=] { return now; });
    check(!restarted.record("api:dj:1", event("0")), "IDs evicted only from log still deduplicate after restart");
    for (int i = 0; i < 101; ++i) model.begin_session("api:dj:next-" + std::to_string(i), {{"liveId", i}});
    state = model.snapshot();
    check(state["manager"]["sessions"].size() == 100 && state["manager"]["sessions"][0]["key"] == "api:dj:next-100", "Session retention keeps most recently created broadcasts");
    check(!model.record("api:dj:1", event("gone")), "Evicted sessions no longer accept events");

    Json oversized = saved_session();
    oversized["totals"]["comments"] = 77777;
    for (int i = 0; i < 1002; ++i) {
        auto input = person("user-" + std::to_string(i));
        input.update({{"comments", 0}, {"entries", 0}, {"hearts", 0}, {"spoons", 0}, {"follows", 0}, {"visits", Json::object()}});
        oversized["users"].push_back(std::move(input));
    }
    for (int i = 0; i < 10004; ++i) oversized["events"].push_back(event("event-" + std::to_string(i)));
    for (int i = 0; i < 20004; ++i) oversized["seen"].push_back("seen-" + std::to_string(i));
    Json sessions = Json::array({oversized});
    for (int i = 1; i < 102; ++i) sessions.push_back(saved_session("api:dj:old-" + std::to_string(i)));
    Model bounded({{"manager", {{"sessions", sessions}}}}, [=] { return now; });
    state = bounded.snapshot();
    const auto& trimmed = find_session(state, "api:dj:1");
    check(state["manager"]["sessions"].size() == 100 && trimmed["users"].size() == 1000 && trimmed["users"].back()["id"] == "user-999", "Restoration bounds sessions and keeps first 1000 participants");
    check(trimmed["events"].size() == 10000 && trimmed["events"][0]["id"] == "event-4", "Restoration retains latest log entries");
    check(trimmed["seen"].size() == 20000 && trimmed["seen"][0] == "seen-4", "Restoration bounds independent ID window");
    check(trimmed["totals"]["comments"] == 77777, "Restoration does not recompute historical totals");
    check(!bounded.record("api:dj:1", event("seen-20003")), "Restored seen window blocks retained duplicate");
    check(bounded.record("api:dj:1", event("seen-20004")), "New event accepted at both retention limits");
    check(bounded.record("api:dj:1", event("seen-4")), "ID can be accepted after expiring from bounded deduplication window");
    bounded.observe("api:dj:1", Json::array({person("overflow"), person("user-0", "updated")}));
    state = bounded.snapshot();
    const auto& full = find_session(state, "api:dj:1");
    check(full["totals"]["comments"] == 77779 && full["users"].size() == 1000, "Events still count at participant capacity");
    check(full["users"][0]["name"] == "updated", "Existing participant refreshes at capacity");
    check(full["events"].size() == 10000 && full["seen"].size() == 20000, "Rolling limits hold after appends");
}

void attendance_and_unicode() {
    std::int64_t now = utc(2026, 11, 6, 14, 59, 59);
    Model model(Json::object(), [&] { return now; });
    model.begin_session("api:dj:1", Json::object());
    model.observe("api:dj:1", Json::array({person(), person("api:dj:dj", "DJ")}));
    model.record("api:dj:1", event("before", "entry", nullptr, person(), "2026-11-06T23:59:59+09:00"));
    now += 1000;
    model.observe("api:dj:1", Json::array({person()}));
    model.record("api:dj:1", event("after", "entry", nullptr, person(), "2026-11-07T00:00:00+09:00"));
    model.record("api:dj:1", event("older", "comment", nullptr, person(), "2026-11-01T00:00:00Z"));
    model.record("api:dj:1", event("invalid", "entry", nullptr, person(), "2026-02-30T00:00:00Z"));
    auto state = model.snapshot();
    const auto& visits = find_session(state, "api:dj:1")["users"][0]["visits"];
    check(visits.size() == 3 && visits.contains("2026-11-06") && visits.contains("2026-11-07"), "JST rolls at UTC 15:00 and offsets normalize correctly");
    check(visits["2026-11-06"]["entries"] == 1 && visits["2026-11-07"]["entries"] == 1, "Entry counts belong to their event dates");
    check(visits["2026-11-06"]["firstSeen"] == "2026-11-06T14:59:59.000Z" && visits["2026-11-07"]["firstSeen"] == "2026-11-06T15:00:00.000Z", "Attendance stores canonical UTC timestamps");
    Model restarted(state, [&] { return now; });
    check(restarted.snapshot() == state, "Existing visits are not reconstructed or double-counted");
    Json legacy = saved_session();
    legacy["users"] = Json::array({{{"id", "api:dj:a"}, {"name", "A"}, {"firstSeen", "2026-11-01T00:00:00Z"}, {"lastSeen", "2026-11-05T00:00:00Z"}}});
    legacy["events"] = Json::array({event("old-entry", "entry", nullptr, person(), "2026-11-03T00:00:00Z"),
        event("bad", "entry", nullptr, person(), "invalid")});
    Model migrated({{"manager", {{"sessions", Json::array({legacy})}}}}, [&] { return now; });
    state = migrated.snapshot();
    const auto& legacy_visits = find_session(state, "api:dj:1")["users"][0]["visits"];
    check(legacy_visits.size() == 3 && !legacy_visits.contains("2026-11-02") && !legacy_visits.contains("2026-11-04"), "Legacy migration uses evidence, never fills dates between observations");
    check(legacy_visits["2026-11-03"]["entries"] == 1, "Legacy retained entries reconstruct visit counts");

    std::string japanese;
    for (int i = 0; i < 130; ++i) japanese += "日";
    std::string emoji;
    for (int i = 0; i < 251; ++i) emoji += "😀";
    model.record("api:dj:1", event("unicode", "comment", nullptr, person("unicode", japanese)));
    auto long_event = event("emoji");
    long_event["text"] = emoji;
    model.record("api:dj:1", long_event);
    state = model.snapshot();
    const auto& saved = find_session(state, "api:dj:1");
    check(saved["users"].back()["name"].get<std::string>().size() == 360, "Name limit counts UTF-16 characters, not UTF-8 bytes");
    check(saved["events"].back()["text"].get<std::string>().size() == 1000, "500 UTF-16 units retain 250 complete emoji");
    check(!state.dump().empty(), "Truncation leaves valid serializable UTF-8");
}

void donations_and_exports() {
    const auto now = utc(2026, 11, 7);
    Model model(Json::object(), [=] { return now; });
    model.begin_session("api:dj:1", {{"liveId", 123}});
    const auto identity = person("=user", "  +SUM(1)\n\"日本語\",😀");
    auto gift = event("@gift", "spoon", 300, identity);
    gift["text"] = "\t=HYPERLINK(\"x\")\r\nhello,world";
    model.record("api:dj:1", gift);
    auto sub = identity;
    sub["subscription"] = {{"plan", "VIP"}, {"futurePlan", 7}};
    model.observe("api:dj:1", Json::array({sub, {{"id", "b"}, {"name", "B"}, {"subscription", nullptr}}, person("c", "C")}));
    model.record("api:dj:1", event("unknown", "heart", nullptr, identity));
    const auto before = find_session(model.snapshot(), "api:dj:1")["totals"];
    const Json rows = Json::array({{{"amount", 10}, {"stickerName", "ハート"}, {"time", "2026-11-06T15:00:00Z"}, {"futureGift", 7}}, {{"amount", 20.5}, {"stickerName", "スプーン"}}});
    model.set_donations("api:dj:1", rows);
    auto state = model.snapshot();
    const auto& saved = find_session(state, "api:dj:1");
    check(saved["donationHistory"]["total"] == 30.5 && saved["donationHistory"]["items"] == rows, "Official history stores a separate exact snapshot and sum");
    check(saved["totals"] == before && saved["events"].size() == 2, "History never adds to realtime totals or logs");
    rejects([&] { model.set_donations("missing", rows); }, "Donations require an existing session");
    rejects([&] { model.set_donations("api:dj:1", Json::array({{{"amount", 1}}, {{"amount", -1}}})); }, "Invalid fetched snapshot rejected in full");
    check(model.snapshot() == state, "Failed donation replacement retains previous history");
    Json too_many = Json::array();
    for (int i = 0; i < 10001; ++i) too_many.push_back({{"amount", 1}});
    rejects([&] { model.set_donations("api:dj:1", too_many); }, "History limit rejects incomplete/truncated replacement");
    check(model.snapshot() == state, "Oversized history does not replace previous data");
    const auto users = read_csv(model.participants_csv("api:dj:1"));
    check(users.size() == 4 && users[0].size() == 14 && users[0][2] == "名前", "Participant CSV has desktop schema and all saved users");
    check(users[1][0] == "123" && users[1][1] == "'=user" && users[1][2] == "'  +SUM(1)\n\"日本語\",😀", "Formula neutralization preserves quoted, multiline Japanese cells");
    check(users[1][8] == "300" && users[1][10] == "1" && users[1][13] == "VIP", "Participant CSV quantities, unknown counts and subscriptions");
    check(users[2][13] == "なし" && users[3][13] == "未取得", "Null and missing subscriptions export distinctly");
    const auto logs = read_csv(model.logs_csv("api:dj:1"));
    check(logs.size() == 3 && logs[0].size() == 9 && logs[1][1] == "'@gift", "Log CSV has desktop schema and protects event IDs");
    check(logs[1][6] == "'\t=HYPERLINK(\"x\")\r\nhello,world" && logs[1][7] == "300" && logs[1][8] == "false", "Log CSV round trips body, quantity and DJ flag");
    check(logs[2][7].empty(), "Unknown quantity is empty, not zero, in CSV");
    check(read_csv(model.logs_csv("missing")).size() == 1 && read_csv(model.participants_csv("missing")).size() == 1, "Missing exports contain only headers");
    const auto before_export = model.snapshot();
    model.analytics_csv();
    check(model.snapshot() == before_export, "Exports do not mutate persistence state");
    model.set_donations("api:dj:1", Json::array());
    state = model.snapshot();
    check(find_session(state, "api:dj:1")["donationHistory"]["total"] == 0, "Empty completed history can replace previous snapshot");
}

void analytics() {
    auto old = saved_session("api:dj:old");
    old["observedAt"] = "2026-11-05T10:00:00Z";
    old["endedAt"] = "2026-11-05T10:30:00Z";
    old["live"]["title"] = "=formula title";
    old["totals"]["comments"] = 15;
    auto recent = saved_session("api:dj:recent");
    recent["totals"]["comments"] = 60;
    auto other = saved_session("api:other:room");
    other["totals"]["comments"] = 999;
    const auto now = utc(2026, 11, 7);
    Model model({{"manager", {{"sessions", Json::array({recent, other, old})}}}}, [=] { return now; });
    auto rows = read_csv(model.analytics_csv());
    check(rows.size() == 3 && rows[0].size() == 9, "Analytics selects only same-DJ history");
    check(rows[1][0] == "api:dj:old" && rows[2][0] == "api:dj:recent", "Analytics sorts by observation timestamp oldest first");
    check(rows[1][1] == "'=formula title" && rows[1][3] == "30.0" && rows[1][8] == "0.50" && rows[2][8] == "2.00", "Analytics escapes titles and uses saved counts / observation minutes");
    Model empty;
    check(read_csv(empty.analytics_csv()).size() == 1, "Empty analysis has just headers");

    auto short_session = saved_session();
    short_session["endedAt"] = "2026-11-06T10:00:20Z";
    short_session["totals"]["comments"] = 10;
    Model short_model({{"manager", {{"sessions", Json::array({short_session})}}}}, [=] { return now; });
    rows = read_csv(short_model.analytics_csv());
    check(rows[1][8].empty(), "Samples shorter than a minute do not invent rates");
    short_session["observedAt"] = "invalid";
    Model invalid_dates({{"manager", {{"sessions", Json::array({short_session})}}}}, [=] { return now; });
    rows = read_csv(invalid_dates.analytics_csv());
    check(rows[1][3] == "0.0" && rows[1][8].empty(), "Unparseable legacy dates cannot yield NaN durations");

    std::int64_t clock = utc(2026, 11, 6, 10, 10);
    auto stale = saved_session();
    stale["endedAt"] = nullptr;
    stale["updatedAt"] = "2026-11-06T10:05:00Z";
    Model active({{"manager", {{"sessions", Json::array({stale})}}}}, [&] { return clock; });
    check(read_csv(active.analytics_csv())[1][3] == "5.0", "Restarted open session is stale until explicitly resumed");
    active.begin_session("api:dj:1", Json::object());
    check(read_csv(active.analytics_csv())[1][3] == "10.0", "Active observation extends to injected now");
    active.finish_session("api:dj:1");
    clock += 60000;
    check(read_csv(active.analytics_csv())[1][3] == "10.0", "Finished observations stop extending");
    Model restored(active.snapshot(), [&] { return clock; });
    check(restored.analytics_csv() == active.analytics_csv(), "Analytics survives restart using persisted timestamps");

    Json history = Json::array();
    for (int i = 1; i <= 12; ++i) {
        auto item = saved_session("api:dj:" + std::to_string(i));
        const auto day = (i < 10 ? "0" : "") + std::to_string(i);
        item["observedAt"] = "2026-10-" + day + "T10:00:00Z";
        item["endedAt"] = "2026-10-" + day + "T10:30:00Z";
        history.push_back(std::move(item));
    }
    Model limited({{"manager", {{"sessions", history}}}}, [=] { return now; });
    rows = read_csv(limited.analytics_csv());
    check(rows.size() == 11 && rows[1][0] == "api:dj:3" && rows.back()[0] == "api:dj:12", "Default analytics range takes latest 10 chronologically");
    auto dom1 = saved_session("dom:1"), dom2 = saved_session("dom:2");
    Model dom({{"manager", {{"sessions", Json::array({dom1, dom2})}}}}, [=] { return now; });
    check(read_csv(dom.analytics_csv()).size() == 2, "Unidentified DOM rooms do not merge by prefix or display name");
}

} // namespace

int main() {
    try {
        fixture_and_settings();
        counting_and_lifecycle();
        manager_preferences();
        retention();
        attendance_and_unicode();
        donations_and_exports();
        analytics();
        std::cout << "model tests passed\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "model tests failed: " << error.what() << '\n';
        return 1;
    }
}
