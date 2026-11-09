#include "spoon/participation.hpp"
#include "spoon/storage.hpp"
#include <windows.h>
#include <bcrypt.h>
#include <httplib.h>
#include <chrono>
#include <fstream>
#include <map>
#include <mutex>
#include <regex>
#include <thread>

namespace spoon {
using Json = nlohmann::json;
namespace {
std::string secret() {
    unsigned char bytes[16];
    if (BCryptGenRandom(nullptr, bytes, sizeof(bytes), BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0) throw std::runtime_error("参加URLを準備できません。");
    std::string value; const char* hex = "0123456789abcdef";
    for (const auto byte : bytes) {value += hex[byte >> 4]; value += hex[byte & 15];} return value;
}
std::string read_asset(const std::filesystem::path& path) {
    std::ifstream file(path, std::ios::binary);
    if (!file) throw std::runtime_error("参加画面を読み込めません。");
    return std::string((std::istreambuf_iterator<char>(file)), {});
}
std::uint64_t instant() {return GetTickCount64();}
}
struct Participation::Impl {
    std::filesystem::path assets, helper, data;
    std::mutex lifecycle, mutex;
    std::unique_ptr<httplib::Server> server;
    std::jthread listener;
    HANDLE process = nullptr, job = nullptr;
    std::string token, origin, error;
    int port = 17865;
    Json published = Json::object(), queue = Json::array();
    struct Client {std::string code; Json user; std::uint64_t expires = 0, last = 0;};
    std::map<std::string, Client> clients;

    Impl(std::filesystem::path a, std::filesystem::path h, std::filesystem::path d) : assets(std::move(a)), helper(std::move(h)), data(std::move(d)) {}
    void stop() {
        if (job) {CloseHandle(job); job = nullptr;}
        if (process) {WaitForSingleObject(process, 3000); CloseHandle(process); process = nullptr;}
        if (server) server->stop();
        if (listener.joinable()) listener.join();
        server.reset(); std::lock_guard lock(mutex);
        token.clear(); origin.clear(); clients.clear(); queue = Json::array(); published = Json::object();
    }
    Json status() {
        std::lock_guard lock(mutex); Json links = Json::array(); std::size_t linked = 0;
        for (const auto& [id, client] : clients) if (client.user.is_object()) ++linked;
        if (!origin.empty() && server) for (const auto* kind : {"shogi", "reversi", "question"}) links.push_back({{"kind", kind}, {"url", origin + "/p/" + token + "/" + kind}});
        return {{"running", server != nullptr && !origin.empty()}, {"participants", linked}, {"links", links}, {"error", error}};
    }
    void start(const std::string& public_origin, int requested_port = 17865) {
        stop(); error.clear(); port = requested_port;
        if (port < 1024 || port > 65535) throw std::runtime_error("参加ページのポートを確認してください。");
        if (!public_origin.empty() && !std::regex_match(public_origin, std::regex(R"(https://[a-zA-Z0-9][a-zA-Z0-9.-]*(?::[0-9]{1,5})?)")) && public_origin != "http://127.0.0.1:" + std::to_string(port)) throw std::runtime_error("固定URLはパスを含まないHTTPSのURLで指定してください。");
        const auto html = read_asset(assets / L"index.html"), script = read_asset(assets / L"portal.js"), css = read_asset(assets / L"portal.css");
        token = secret(); auto service = std::make_unique<httplib::Server>();
        service->new_task_queue = [] {return new httplib::ThreadPool(4);};
        service->set_payload_max_length(4096); service->set_read_timeout(5, 0); service->set_write_timeout(5, 0);
        service->set_pre_routing_handler([](const httplib::Request&, httplib::Response& response) {
            response.set_header("Cache-Control", "no-store"); response.set_header("Referrer-Policy", "no-referrer"); response.set_header("X-Content-Type-Options", "nosniff");
            response.set_header("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
            return httplib::Server::HandlerResponse::Unhandled;
        });
        const auto prefix = "/p/" + token + "/";
        service->Get(prefix + R"((shogi|reversi|question))", [html](const httplib::Request&, httplib::Response& response) {response.set_content(html, "text/html; charset=utf-8");});
        service->Get(prefix + "portal.js", [script](const httplib::Request&, httplib::Response& response) {response.set_content(script, "text/javascript; charset=utf-8");});
        service->Get(prefix + "portal.css", [css](const httplib::Request&, httplib::Response& response) {response.set_content(css, "text/css; charset=utf-8");});
        service->Post(prefix + "join", [this](const httplib::Request& request, httplib::Response& response) {
            std::lock_guard lock(mutex);
            if (!valid_origin(request)) {response.status = 403; return;}
            auto id = request.get_header_value("X-Participant");
            if (!std::regex_match(id, std::regex("[a-f0-9]{32}"))) {response.status = 400; return;}
            if (!clients.contains(id)) {
                if (clients.size() >= 500) {response.status = 429; return;}
                const auto code = secret().substr(0, 10);
                clients[id] = {code, nullptr, instant() + 600000, 0};
            }
            auto& client = clients[id];
            if (!client.user.is_object() && client.expires < instant()) {client.code = secret().substr(0, 10); client.expires = instant() + 600000;}
            response.set_content(Json{{"code", client.code}, {"user", client.user}}.dump(), "application/json");
        });
        service->Get(prefix + "state", [this](const httplib::Request& request, httplib::Response& response) {
            std::lock_guard lock(mutex); auto found = clients.find(request.get_header_value("X-Participant"));
            if (found == clients.end()) {response.status = 401; return;}
            Json state = {{"title", published.value("title", "配信への参加")}, {"requestsOpen", published.value("requestsOpen", false)}, {"user", found->second.user}, {"games", Json::array()}};
            if (found->second.user.is_object()) {
                const auto id = found->second.user.value("id", "");
                for (const auto& game : published.value("games", Json::array())) for (const auto& player : game.value("userIds", Json::array())) if (player == id) {state["games"].push_back(game); break;}
                state["result"] = published.value("results", Json::object()).value(id, Json());
            }
            response.set_content(state.dump(), "application/json");
        });
        service->Post(prefix + "action", [this](const httplib::Request& request, httplib::Response& response) {
            std::lock_guard lock(mutex);
            if (!valid_origin(request)) {response.status = 403; return;}
            auto found = clients.find(request.get_header_value("X-Participant"));
            if (found == clients.end() || !found->second.user.is_object()) {response.status = 401; return;}
            auto& client = found->second;
            if (queue.size() >= 100 || instant() - client.last < 700) {response.status = 429; return;}
            auto input = Json::parse(request.body, nullptr, false);
            if (!input.is_object()) {response.status = 400; return;}
            const auto kind = input.value("kind", ""), action = input.value("action", "");
            if ((kind != "question" && kind != "shogi" && kind != "reversi") || (action != "question" && action != "start" && action != "move" && action != "end")) {response.status = 400; return;}
            if (kind == "question" && !published.value("requestsOpen", false)) {response.status = 409; return;}
            client.last = instant(); input["user"] = client.user; input["id"] = secret();
            queue.push_back(input); response.set_content(Json{{"ok", true}, {"id", input["id"]}}.dump(), "application/json");
        });
        if (!service->bind_to_port("127.0.0.1", port)) throw std::runtime_error("参加ページのポートが使用中です。他のSpoon Managerを終了してください。");
        server = std::move(service); listener = std::jthread([this] {server->listen_after_bind();});
        const auto deadline = instant() + 3000;
        while (!server->is_running() && instant() < deadline) std::this_thread::sleep_for(std::chrono::milliseconds(5));
        if (!server->is_running()) throw std::runtime_error("参加ページを開始できませんでした。");
        if (!public_origin.empty()) {std::lock_guard lock(mutex); origin = public_origin; return;}
        if (!std::filesystem::exists(helper)) throw std::runtime_error("一時URLの公開ツールがありません。最新版をインストールするか、固定URLを指定してください。");
        std::filesystem::create_directories(data); const auto log = data / L"tunnel.log", config = data / L"tunnel.yml";
        write_text_atomic(log, ""); write_text_atomic(config, "{}\n");
        std::wstring command = L"\"" + helper.wstring() + L"\" tunnel --config \"" + config.wstring() + L"\" --no-autoupdate --url http://127.0.0.1:" + std::to_wstring(port) + L" --protocol http2 --logfile \"" + log.wstring() + L"\"";
        STARTUPINFOW startup{sizeof(startup)}; startup.dwFlags = STARTF_USESHOWWINDOW; startup.wShowWindow = SW_HIDE;
        PROCESS_INFORMATION info{};
        job = CreateJobObjectW(nullptr, nullptr);
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{}; limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if (!job || !SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits)) || !CreateProcessW(helper.c_str(), command.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW | CREATE_SUSPENDED, nullptr, helper.parent_path().c_str(), &startup, &info)) throw std::runtime_error("一時URLの公開ツールを起動できません。");
        process = info.hProcess;
        if (!AssignProcessToJobObject(job, process)) {TerminateProcess(process, 1); CloseHandle(info.hThread); throw std::runtime_error("公開ツールを管理できません。");}
        ResumeThread(info.hThread); CloseHandle(info.hThread);
        const auto until = instant() + 30000; const std::regex url(R"(https://[a-z0-9-]+\.trycloudflare\.com)");
        while (instant() < until) {
            if (WaitForSingleObject(process, 0) == WAIT_OBJECT_0) break;
            std::ifstream file(log, std::ios::binary); std::string contents((std::istreambuf_iterator<char>(file)), {}); std::smatch match;
            if (std::regex_search(contents, match, url)) {std::lock_guard lock(mutex); origin = match.str(); return;}
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
        }
        throw std::runtime_error("一時URLを取得できませんでした。ネットワークを確認するか、固定URLで公開してください。");
    }
    bool valid_origin(const httplib::Request& request) const {
        const auto value = request.get_header_value("Origin");
        return value == origin || value == "http://127.0.0.1:" + std::to_string(port);
    }
};
Participation::Participation(std::filesystem::path assets, std::filesystem::path helper, std::filesystem::path data) : impl_(std::make_unique<Impl>(std::move(assets), std::move(helper), std::move(data))) {}
Participation::~Participation() {stop();}
void Participation::stop() {std::lock_guard lock(impl_->lifecycle); impl_->stop();}
Json Participation::action(const std::string& action, const Json& input) {
    std::lock_guard lifecycle(impl_->lifecycle);
    if (action == "start") {try {impl_->start(input.value("publicOrigin", ""), input.value("port", 17865));} catch (...) {impl_->stop(); throw;} return impl_->status();}
    if (action == "stop") {impl_->stop(); return impl_->status();}
    if (action == "status") return impl_->status();
    if (action == "sync") {
        std::lock_guard lock(impl_->mutex); impl_->published = input.value("state", Json::object());
        const auto ack = input.value("ack", Json::array());
        for (auto it = impl_->queue.begin(); it != impl_->queue.end();) {
            bool done = false; for (const auto& id : ack) if (id == (*it)["id"]) done = true;
            if (done) it = impl_->queue.erase(it); else ++it;
        }
        return {{"actions", impl_->queue}};
    }
    if (action == "link") {
        std::lock_guard lock(impl_->mutex); const auto code = input.value("code", "");
        const auto user = input.value("user", Json());
        if (!user.is_object() || !user.contains("id") || !user["id"].is_string()) throw std::runtime_error("参加者を確認できません。");
        for (auto& [id, client] : impl_->clients) if (client.code == code && client.expires > instant()) {
            if (client.user.is_object() && client.user["id"] != user["id"]) throw std::runtime_error("この確認コードは使用済みです。");
            client.user = user; return {{"ok", true}};
        }
        throw std::runtime_error("確認コードの有効期限が切れたか、コードが違います。参加ページを開き直してください。");
    }
    throw std::invalid_argument("参加ページの操作を確認してください。");
}
}
