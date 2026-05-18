"""Quick R2 inventory — shows which series/issues have pages uploaded."""
import os, boto3

s3 = boto3.client(
    "s3",
    endpoint_url="https://ad538fc9c2621046b7e268939b6bd200.r2.cloudflarestorage.com",
    aws_access_key_id="521fbbe7e83b63190ff8a0df33bab0cd",
    aws_secret_access_key="1d3d4e2992cfefac7439ab61ff6aa81b2f5e7ae4dff371160a7b050f7a68f900",
    region_name="auto",
)

resp = s3.list_objects_v2(Bucket="netcomix", Delimiter="/")
series_prefixes = [p["Prefix"] for p in resp.get("CommonPrefixes", [])]
print(f"Series in R2: {len(series_prefixes)}")
for prefix in series_prefixes:
    r = s3.list_objects_v2(Bucket="netcomix", Prefix=prefix, Delimiter="/")
    subs = [x["Prefix"] for x in r.get("CommonPrefixes", [])]
    print(f"\n  {prefix.rstrip('/').split('/')[-1]}: {len(subs)} issues")
    for sub in subs:
        r2 = s3.list_objects_v2(Bucket="netcomix", Prefix=sub)
        print(f"    {sub.rstrip('/').split('/')[-1]}: {r2.get('KeyCount',0)} pages")
