"""Project routine routes and the company inbox's local run receipts."""

from starlette.requests import Request

from aiopc.routines import LocalRoutines


def routine_routes(service: LocalRoutines, workspace, body, respond):
    async def collection(request: Request):
        root = workspace(request)
        if request.method == "POST":
            return respond(service.create(root, await body(request)), 201)
        return respond(service.list(root))

    async def item(request: Request):
        root, routine_id = workspace(request), request.path_params["routine_id"]
        if request.method == "DELETE":
            service.archive(root, routine_id)
            return respond({"deleted": True})
        return respond(service.update(root, routine_id, await body(request)))

    async def runs(request: Request):
        root, routine_id = workspace(request), request.path_params["routine_id"]
        if request.method == "POST":
            return respond(service.enqueue(root, routine_id), 202)
        return respond({"items": service.runs(root, routine_id)})

    async def results(request: Request):
        return respond({"items": service.results(workspace(request))})

    return [
        ("/api/routines", collection, ["GET", "POST"]),
        ("/api/routines/{routine_id}", item, ["PATCH", "DELETE"]),
        ("/api/routines/{routine_id}/runs", runs, ["GET", "POST"]),
        ("/api/routine-results", results, ["GET"]),
    ]
