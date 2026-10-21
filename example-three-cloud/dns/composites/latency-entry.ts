// One cloud's way in through Route 53: a latency record for the shared name,
// guarded by a health check on that cloud's endpoint. A record whose check
// fails stops answering, and the other clouds' records take its traffic.
//
// Two shapes, by what the cloud hands over. HostnameEntry is for an endpoint
// with a hostname (a load balancer's, a Container App's): the record is a
// CNAME to it and the check probes it by name. AddressEntry is for an
// endpoint that is an IP address (a GCP load balancer): it gets a name of its
// own, an A record, the latency record points at that name, and the check
// probes the address.
//
// Latency records sharing a name must share a type, which is why the address
// gets its own A record instead of the latency record being one.
//
// The bodies are `const`s and a `return`, so `chant build` reads them rather
// than running them.
import { Composite } from "@intentius/chant";
import { HealthCheck, RecordSet } from "@intentius/chant-lexicon-aws";

export interface EntryProps {
  /** The hosted zone's id (`zone.Id`). */
  zoneId: string;
  /** The name every cloud answers for. */
  name: string;
  /** The cloud, as the record's set identifier. */
  id: string;
  /** The AWS region whose latency this record is chosen for. */
  region: string;
  /** The cloud's endpoint: a hostname, or for AddressEntry an IP address. */
  endpoint: string;
}

export const HostnameEntry = Composite((props: EntryProps) => {
  const check = new HealthCheck({
    HealthCheckConfig: { Type: "HTTP", FullyQualifiedDomainName: props.endpoint, ResourcePath: "/", RequestInterval: 10, FailureThreshold: 1 },
  });
  const record = new RecordSet({
    HostedZoneId: props.zoneId,
    Name: props.name,
    Type: "CNAME",
    TTL: "60",
    SetIdentifier: props.id,
    Region: props.region,
    ResourceRecords: [props.endpoint],
    HealthCheckId: check.HealthCheckId,
  });
  return { check, record };
}, "HostnameEntry");

export interface AddressEntryProps extends EntryProps {
  /** The name the address is published under (an A record), which the latency record points at. */
  origin: string;
  /** The port the check probes. */
  port: number;
}

export const AddressEntry = Composite((props: AddressEntryProps) => {
  const check = new HealthCheck({
    HealthCheckConfig: { Type: "HTTP", IPAddress: props.endpoint, Port: props.port, ResourcePath: "/", RequestInterval: 10, FailureThreshold: 1 },
  });
  const origin = new RecordSet({ HostedZoneId: props.zoneId, Name: props.origin, Type: "A", TTL: "60", ResourceRecords: [props.endpoint] });
  const record = new RecordSet({
    HostedZoneId: props.zoneId,
    Name: props.name,
    Type: "CNAME",
    TTL: "60",
    SetIdentifier: props.id,
    Region: props.region,
    ResourceRecords: [props.origin],
    HealthCheckId: check.HealthCheckId,
  });
  return { check, origin, record };
}, "AddressEntry");
