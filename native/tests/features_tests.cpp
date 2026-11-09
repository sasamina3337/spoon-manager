#include "spoon/application.hpp"
#include "spoon/participation.hpp"
#include "spoon/storage.hpp"
#include "spoon/http.hpp"
#include <windows.h>
#include <httplib.h>
#include <atomic>
#include <chrono>
#include <iostream>
#include <thread>

namespace {
using spoon::Json;
using namespace std::chrono_literals;
void require(bool condition, const char* message) {if (!condition) throw std::runtime_error(message);}
template<class F> void eventually(F predicate, const char* message) {
    const auto until = std::chrono::steady_clock::now() + 3s;
    while (!predicate() && std::chrono::steady_clock::now() < until) std::this_thread::sleep_for(5ms);
    require(predicate(), message);
}
struct Directory {
    std::filesystem::path path = std::filesystem::temp_directory_path() / ("spoon-features-" + std::to_string(GetCurrentProcessId()) + "-" + std::to_string(GetTickCount64()));
    Directory() {std::filesystem::create_directory(path);}
    ~Directory() {std::error_code error; std::filesystem::remove_all(path, error);}
};
void test_receiving_and_tools() {
    Directory data; httplib::Server server; std::atomic<bool> release{false}, streaming{false}, deny_donations{false}; std::atomic<int> sent{0}, follows{0};
    server.Get("/v1/me", [](auto&, auto& response) {response.set_content(R"({"userId":"dj"})", "application/json");});
    server.Get("/v1/live", [](auto&, auto& response) {response.set_content(R"({"liveId":1,"title":"Test live","listenerCount":1,"isChatFrozen":false})", "application/json");});
    server.Get("/v1/live/listeners", [](auto&, auto& response) {response.set_content(R"({"listeners":[{"id":"user","nickname":"Listener"}],"nextCursor":null})", "application/json");});
    server.Get("/v1/live/fans", [](auto&, auto& response) {response.set_content(R"({"fans":[{"id":"user","nickname":"Listener","rank":1,"spoonCount":20}]})", "application/json");});
    server.Get("/v1/live/donations", [&](const auto& request, auto& response) {
        if (deny_donations) {response.status = 403; response.set_content("private upstream error", "text/plain"); return;}
        response.set_content(request.has_param("cursor") ? R"({"donations":[{"user":{"id":"user","nickname":"Listener"},"stickerName":"gift2","amount":5,"time":"2026-11-07T12:00:01Z"}],"nextCursor":null})" : R"({"donations":[{"user":{"id":"user","nickname":"Listener"},"stickerName":"gift1","amount":20,"time":"2026-11-07T12:00:00Z"}],"nextCursor":"next"})", "application/json");
    });
    server.Post("/v1/live/chat", [&](const auto&, auto& response) {++sent; response.status=204;});
    server.Post("/v1/live/follow", [&](const auto&, auto& response) {++follows; response.status=204;});
    server.Get("/speakers", [](auto&, auto& response) {response.set_content(R"([{"name":"Voice","styles":[{"name":"Normal","id":2}]}])", "application/json");});
    server.Get("/v1/live/events", [&](auto&, auto& response) {
        response.set_chunked_content_provider("text/event-stream", [&](std::size_t offset, httplib::DataSink& sink) {
            if (!offset) {
                const std::string message = "id: small-1\nevent: chat\ndata: {\"user\":{\"id\":\"user\",\"nickname\":null},\"message\":\"\xE3\x81\x82\",\"isDj\":false,\"sentTime\":\"2026-11-07T12:00:00Z\"}\n\n";
                sink.write(message.data(), message.size()); streaming=true; return true;
            }
            while (!release) std::this_thread::sleep_for(5ms);
            sink.done(); return true;
        });
    });
    const auto port=server.bind_to_any_port("127.0.0.1"); require(port>0,"Could not bind mock API");
    std::jthread listener([&] {server.listen_after_bind();}); server.wait_until_ready();
    struct Cleanup {httplib::Server& server; std::atomic<bool>& release; ~Cleanup(){release=true;server.stop();}} cleanup{server,release};
    const auto origin="http://127.0.0.1:"+std::to_string(port);
    spoon::write_json_atomic(data.path / "connection.json", {{"clientId","test"},{"clientSecret","secret"},{"region","jp"},{"port",17867}});
    spoon::write_json_atomic(data.path / "spoon/tokens.json", {{"clientId","test"},{"region","jp"},{"token",{{"access_token","test-token"},{"refresh_token","test-refresh"},{"expiresAt",std::uint64_t{4102444800000}},{"scope","me.read live.read listeners.read events.chat chat.send fans.read donations.read dj.follow"}}}});
    {
        spoon::Application app(data.path,origin);
        auto settings=app.snapshot()["settings"];settings["enabled"]=false; settings["provider"]="engine";settings["engineUrl"]=origin;
        app.save_settings(settings,{{"features",{{"chat",true}}}});
        app.start_receiving();
        eventually([&] {return streaming.load() && app.snapshot()["manager"]["sessions"].size()==1 && app.snapshot()["manager"]["sessions"][0]["events"].size()==1;}, "Real-time comment was not recorded while SSE stayed open");
        auto state=app.snapshot();require(state["_native"]["connectionState"]=="connected","Connected state is not backed by SSE activity");
        require(state["manager"]["sessions"][0]["totals"]["comments"]==1,"Received comment was not counted");
        require(state["manager"]["sessions"][0]["events"][0]["text"]=="\xE3\x81\x82","UTF-8 comment was corrupted");
        require(app.manager_action("fans","api:dj:1",{})["fans"].size()==1,"Fan ranking did not reach API");
        app.manager_action("donations","api:dj:1",{});
        require(app.snapshot()["manager"]["sessions"][0]["donationHistory"]["total"]==25,"Donation pages were not combined correctly");
        require(app.snapshot()["manager"]["sessions"][0]["totals"]["spoons"]==0,"History double-counted streamed totals");
        deny_donations = true;
        bool denied = false;
        try { app.manager_action("donations", "api:dj:1", {}); }
        catch (const spoon::HttpError& error) {
            const std::string message = error.what();
            denied = error.status == 403 && message.find("donations.read") != std::string::npos &&
                message.find("DJの追加同意を取得") != std::string::npos && message.find("private upstream error") == std::string::npos;
        }
        require(denied, "Donation permission error did not explain how to renew consent");
        require(app.snapshot()["manager"]["sessions"][0]["donationHistory"]["total"]==25,"Permission failure replaced saved donation history");
        deny_donations = false;
        require(app.voice_catalog()[0]["name"]=="Voice（Normal）","VOICEVOX catalog was not flattened");
        app.manager_action("refresh","api:dj:1",{});
        require(app.snapshot()["_native"]["listeners"].size()==1,"Current listeners were not refreshed");
        app.manager_action("follow","api:dj:1",{}); require(follows==1,"Follow was not dispatched once");
        app.send_generated("api:dj:1","Hello","bot",""); require(sent==1,"Bot reply was not sent");
        app.save_runtime({{"assignments",{{"api:dj:user",8}}}});
        app.stop_receiving(); release=true;
        require(app.snapshot()["_native"]["receiving"]==false,"Stop did not reset receiving state");
    }
    spoon::Application reopened(data.path,origin); require(reopened.snapshot()["runtime"]["assignments"]["api:dj:user"]==8,"Runtime settings did not survive restart");
}
void test_participation_boundary() {
    Directory data;
    httplib::Server probe; const auto port=probe.bind_to_any_port("127.0.0.1");
    std::jthread probe_thread([&]{probe.listen_after_bind();});probe.wait_until_ready();probe.stop();probe_thread.join();
    const auto origin="http://127.0.0.1:"+std::to_string(port);
    spoon::Participation portal(std::filesystem::path(SPOON_SOURCE_DIR)/"desktop/renderer/portal",{},data.path);
    const auto status=portal.action("start",{{"publicOrigin",origin},{"port",port}});
    const auto url=status["links"][0]["url"].get<std::string>(); const auto prefix=url.substr(origin.size(),url.rfind('/')-origin.size()+1);
    httplib::Client client(origin);client.set_connection_timeout(2);client.set_read_timeout(2);
    const httplib::Headers headers{{"Origin",origin},{"X-Participant","0123456789abcdef0123456789abcdef"}};
    const auto joined=client.Post((prefix+"join").c_str(),headers,"{}","application/json");require(joined && joined->status==200,"Portal registration failed");
    const auto code=Json::parse(joined->body)["code"];
    auto reply=client.Post((prefix+"action").c_str(),headers,R"({"kind":"question","action":"question","text":"Test"})","application/json");require(reply&&reply->status==401,"Unverified participant could submit");
    portal.action("link",{{"code",code},{"user",{{"id","api:dj:user"},{"name","Listener"}}}});
    portal.action("sync",{{"state",{{"title","Test"},{"requestsOpen",true}}},{"ack",Json::array()}});
    reply=client.Post((prefix+"action").c_str(),headers,R"({"kind":"question","action":"question","text":"Test"})","application/json");require(reply&&reply->status==200,"Verified question was rejected");
    auto actions=portal.action("sync",{{"state",{{"title","Test"},{"requestsOpen",true}}},{"ack",Json::array()}})["actions"];
    require(actions.size()==1 && actions[0]["user"]["id"]=="api:dj:user","Portal input did not retain verified identity");
    require(portal.action("sync",{{"state",Json::object()},{"ack",Json::array({actions[0]["id"]})}})["actions"].empty(),"Portal acknowledgements did not clear inputs");
    const auto management=client.Get("/connection"); require(management&&management->status==404,"Portal exposed management endpoint");
    portal.stop();require(!portal.action("status",{})["running"].get<bool>(),"Portal did not stop");
}
}
int main() {
    try {test_receiving_and_tools();test_participation_boundary();std::cout<<"PASS end-to-end SSE, native tools, durable runtime and scoped participation\n";return 0;}
    catch(const std::exception& error){std::cerr<<"FAIL "<<error.what()<<'\n';return 1;}
}
